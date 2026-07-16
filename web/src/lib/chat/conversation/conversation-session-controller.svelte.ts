// Chat session controller. Owns chat lifecycle transitions, message
// submission, permission decisions, queue control, and mode persistence.
// No direct DOM access -- all viewport operations are delegated via
// callback functions supplied through the deps interface.

import {
	createQueuedInput,
	deleteQueuedInput,
	getChatQueue,
	replaceQueuedInput,
	resumeChatQueue,
	runChat,
	sendActiveInput,
	sendPermissionDecision,
	startChat,
	stopChat,
	updateChatModel,
	updateExecutionSettings,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import type { ChatImage } from '$shared/chat-types';
import { normalizeQueueState, type QueueState } from '$shared/queue-state';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import { parseForkCommand } from '$lib/chat/composer/fork-command.js';
import {
	parseCompactCommand,
	isCodexGoalCommand,
	parseRenameCommand,
	parseScheduleInCommand,
	parseSteerCommand,
} from '$lib/chat/composer/slash-commands.js';
import {
	INITIAL_VISIBLE_MESSAGES,
	type ActiveTranscriptState,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { AmpAgentMode, PermissionMode, ThinkingMode } from '$lib/types/chat';
import { normalizeThinkingModeForAgent } from '$shared/chat-modes';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { SessionAgentId } from '$lib/types/app';
import type { ApiProtocol } from '$shared/api-providers';
import type {
	PermissionDecisionPayload,
	QueueCommandErrorResponse,
} from '$shared/chat-command-contracts';
import type { ChatListEntry } from '$shared/chat-list';
import {
	ConversationAgentSwitchService,
	type AgentSwitchSelection,
} from '$lib/chat/conversation/conversation-agent-switch-service.js';
import { ConversationSlashCommandService } from '$lib/chat/conversation/conversation-slash-command-service.js';
import {
	errorDetail,
	pendingUserInput,
	prepareChatImages,
} from '$lib/chat/conversation/conversation-submission-helpers.js';
import * as m from '$lib/paraglide/messages.js';

type SessionTranscriptState = Pick<
	ActiveTranscriptState,
	| 'activeChatId'
	| 'chatMessages'
	| 'isUserScrolledUp'
	| 'activateChat'
	| 'appendLocalNotice'
	| 'clearLocalNotices'
	| 'loadMessages'
	| 'updatePendingUserInputDeliveryStatus'
	| 'upsertPendingUserInput'
> & {
	transcriptCache: Pick<ChatTranscriptCache, 'markValidated'>;
};

type SessionComposerState = Pick<
	ComposerState,
	| 'inputText'
	| 'images'
	| 'isSubmitting'
	| 'clearAfterSubmit'
	| 'clearImages'
	| 'restoreDraft'
	| 'saveDraft'
>;

type SessionAgentState = Pick<
	AgentState,
	| 'agentId'
	| 'model'
	| 'apiProviderId'
	| 'modelEndpointId'
	| 'modelProtocol'
	| 'permissionMode'
	| 'thinkingMode'
	| 'claudeThinkingMode'
	| 'ampAgentMode'
	| 'setAgentId'
	| 'setModelSelection'
>;

type SessionLifecycleState = Pick<
	ConversationLifecycleState,
	| 'currentChatId'
	| 'loadingStatus'
	| 'beginTurn'
	| 'clearTurnStatus'
	| 'markTurnRunning'
	| 'setCurrentChatId'
	| 'setLoadingStatus'
>;

type SessionConversationUiState = Pick<
	ConversationUiState,
	| 'pendingPermissionRequests'
	| 'previousPermissionMode'
	| 'clearPendingPermissionRequests'
	| 'getQueue'
	| 'setMessageQueue'
	| 'setMessageQueueFromRefresh'
	| 'setPendingPermissionRequests'
	| 'setPreviousPermissionMode'
>;

type SessionStartupCoordinator = Pick<StartupCoordinator, 'beginLocalStartup' | 'completeStartup'>;

export interface SessionControllerDeps {
	sessions: {
		selectedChatId: string | null;
		selectedChat: ChatSessionRecord | null;
		byId: Record<string, ChatSessionRecord>;
		startupByChatId: Record<string, ChatStartupConfig>;
		isDraft: (chatId: string) => boolean;
		patchDraftStartup: (chatId: string, patch: Partial<ChatStartupConfig>) => void;
		patchChat: (chatId: string, patch: Partial<ChatSessionRecord>) => void;
		patchLastReadAt: (chatId: string, lastReadAt: string) => void;
		applyStartEntry: (entry: ChatListEntry) => void;
		upsertServerChat: (entry: ChatListEntry) => void;
		setChatProcessing: (chatId: string, isProcessing: boolean) => void;
		setSelectedChatId: (id: string | null) => void;
		renameChat: (chatId: string, newTitle: string) => Promise<boolean>;
	};
	chatState: SessionTranscriptState;
	composerState: SessionComposerState;
	agentState: SessionAgentState;
	lifecycle: SessionLifecycleState;
	conversationUi: SessionConversationUiState;
	startupCoordinator: SessionStartupCoordinator;
	modelCatalog: {
		isLocalModel: (
			agentId: SessionAgentId,
			model: string,
			modelEndpointId?: string | null,
		) => boolean;
		selectionFor: (
			agentId: SessionAgentId,
			model: string,
			modelEndpointId?: string | null,
		) => {
			model: string;
			apiProviderId: string | null;
			modelEndpointId: string | null;
			modelProtocol: ApiProtocol | null;
		};
		selectionValueFor: (
			agentId: SessionAgentId,
			model: string,
			modelEndpointId?: string | null,
		) => string;
		getAgentLabel: (agentId: SessionAgentId) => string;
		supportsFork: (agentId: SessionAgentId) => boolean;
		supportsForkWhileRunning: (agentId: SessionAgentId) => boolean;
	};
	appShell: {
		openNewChatDialog: (opts: { prefill: string }) => void;
	};
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	navigation: { navigateToChat?: (chatId: string) => void };
	/** Rebuilds the chat transcript from native history (e.g. after an agent switch). */
	reloadTranscript?: (chatId: string) => Promise<void>;
	setIsViewportPinnedToBottom: (v: boolean) => void;
	setInitialBottomRestorePending: (chatId: string | null) => void;
	scrollToBottom: () => void;
}

function queueFromMutationError(error: unknown): QueueState | null {
	if (!(error instanceof ApiError) || !isQueueCommandErrorResponse(error.payload)) return null;
	return error.payload.queue ? normalizeQueueState(error.payload.queue) : null;
}

function isQueueCommandErrorResponse(value: unknown): value is QueueCommandErrorResponse {
	if (!value || typeof value !== 'object') return false;
	const body = value as Record<string, unknown>;
	return (
		body.success === false &&
		typeof body.error === 'string' &&
		typeof body.errorCode === 'string' &&
		typeof body.retryable === 'boolean'
	);
}

function isDepartedQueueEntryError(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(error.errorCode === 'QUEUE_ENTRY_ALREADY_SENT' || error.errorCode === 'QUEUE_ENTRY_NOT_FOUND')
	);
}

interface FailedQueueSubmission {
	sequence: number;
	text: string;
	images: File[];
}

export class ConversationSessionController {
	#lastChatId: string | null = null;
	#queueRefreshByChatId = new Map<string, Promise<void>>();
	#queueSubmissionSequence = 0;
	#pendingQueueSubmissionsByChatId = new Map<string, number>();
	#failedQueueSubmissionsByChatId = new Map<string, FailedQueueSubmission[]>();
	readonly #slashCommands: ConversationSlashCommandService;
	readonly #agentSwitch: ConversationAgentSwitchService;

	constructor(private deps: SessionControllerDeps) {
		this.#slashCommands = new ConversationSlashCommandService(deps);
		this.#agentSwitch = new ConversationAgentSwitchService(deps);
	}

	#resetSelectionState(): void {
		const { deps } = this;
		deps.chatState.activateChat(null);
		deps.composerState.inputText = '';
		deps.composerState.clearImages();
		deps.lifecycle.clearTurnStatus();
		deps.lifecycle.setCurrentChatId(null);
		deps.conversationUi.clearPendingPermissionRequests();
		deps.setIsViewportPinnedToBottom(true);
		deps.setInitialBottomRestorePending(null);
	}

	#markPendingUserInputDelivery(
		clientRequestId: string,
		deliveryStatus: 'accepted' | 'failed',
	): void {
		this.deps.chatState.updatePendingUserInputDeliveryStatus(clientRequestId, deliveryStatus);
	}

	#beginQueueSubmission(chatId: string): number {
		const pendingCount = this.#pendingQueueSubmissionsByChatId.get(chatId) ?? 0;
		if (pendingCount === 0) this.deps.chatState.clearLocalNotices();
		this.#pendingQueueSubmissionsByChatId.set(chatId, pendingCount + 1);
		return ++this.#queueSubmissionSequence;
	}

	#recordQueueSubmissionFailure(chatId: string, failure: FailedQueueSubmission): void {
		const failures = this.#failedQueueSubmissionsByChatId.get(chatId) ?? [];
		this.#failedQueueSubmissionsByChatId.set(chatId, [...failures, failure]);
	}

	#finishQueueSubmission(chatId: string): void {
		const remaining = (this.#pendingQueueSubmissionsByChatId.get(chatId) ?? 1) - 1;
		if (remaining > 0) {
			this.#pendingQueueSubmissionsByChatId.set(chatId, remaining);
			return;
		}

		this.#pendingQueueSubmissionsByChatId.delete(chatId);
		const failures = this.#failedQueueSubmissionsByChatId.get(chatId) ?? [];
		this.#failedQueueSubmissionsByChatId.delete(chatId);
		if (failures.length === 0 || this.deps.sessions.selectedChatId !== chatId) return;

		const composerUntouched =
			this.deps.composerState.inputText.length === 0 && this.deps.composerState.images.length === 0;
		if (!composerUntouched) return;

		const earliestFailure = failures.reduce((earliest, failure) =>
			failure.sequence < earliest.sequence ? failure : earliest,
		);
		this.deps.composerState.inputText = earliestFailure.text;
		this.deps.composerState.images = earliestFailure.images;
		this.deps.composerState.saveDraft(chatId);
	}

	#startQueueRefresh(chatId: string): Promise<void> {
		const refresh = getChatQueue(chatId).then((result) => {
			this.deps.conversationUi.setMessageQueueFromRefresh(chatId, result.queue);
		});
		this.#queueRefreshByChatId.set(chatId, refresh);
		void refresh
			.catch(() => {
				// A later broadcast, reconnect, or server-side admission check still preserves FIFO.
			})
			.finally(() => {
				if (this.#queueRefreshByChatId.get(chatId) === refresh) {
					this.#queueRefreshByChatId.delete(chatId);
				}
			});
		return refresh;
	}

	async #settleQueueRefresh(refresh: Promise<void>): Promise<void> {
		try {
			await refresh;
		} catch {
			// The server rejects a direct run while durable queued inputs are pending.
		}
	}

	// Deduplicates chat-switch calls so the component effect can be stateless.
	handleChatSwitchIfChanged(chatId: string | null): void {
		if (chatId === this.#lastChatId) return;
		// Route selection can arrive before the chat-list record. Defers the
		// transition so hydration can retry without poisoning the dedupe key.
		if (chatId && !this.deps.sessions.byId[chatId]) return;
		if (this.#lastChatId) {
			this.deps.composerState.saveDraft(this.#lastChatId);
		}
		this.#lastChatId = chatId;
		this.handleChatSwitch(chatId);
	}

	// Resets per-chat state and loads messages when the selected chat changes.
	handleChatSwitch(chatId: string | null): void {
		const { deps } = this;
		if (!chatId) {
			this.#resetSelectionState();
			return;
		}

		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) {
			this.#resetSelectionState();
			return;
		}

		deps.setInitialBottomRestorePending(selected.status === 'draft' ? null : chatId);

		// Restores cached messages immediately while the server round-trip completes.
		const restored = deps.chatState.activateChat(chatId);
		if (restored) {
			requestAnimationFrame(() => deps.scrollToBottom());
		}

		deps.composerState.inputText = '';
		deps.composerState.clearImages();
		deps.lifecycle.clearTurnStatus();
		deps.conversationUi.clearPendingPermissionRequests();
		deps.setIsViewportPinnedToBottom(true);

		if (selected.agentId) {
			deps.agentState.setAgentId(selected.agentId);
		}
		if (selected.model) {
			const modelValue = deps.modelCatalog.selectionValueFor(
				selected.agentId,
				selected.model,
				selected.modelEndpointId,
			);
			deps.agentState.setModelSelection({
				model: modelValue,
				apiProviderId: selected.apiProviderId ?? null,
				modelEndpointId: selected.modelEndpointId ?? null,
				modelProtocol: selected.modelProtocol ?? null,
			});
		}

		if (selected.status === 'draft') {
			deps.lifecycle.setCurrentChatId(null);
			const startup = deps.sessions.startupByChatId[chatId];
			if (startup) {
				deps.agentState.setAgentId(
					startup.agentId as Parameters<typeof deps.agentState.setAgentId>[0],
				);
				const modelValue = deps.modelCatalog.selectionValueFor(
					startup.agentId,
					startup.model,
					startup.modelEndpointId,
				);
				deps.agentState.setModelSelection({
					model: modelValue,
					apiProviderId: startup.apiProviderId ?? null,
					modelEndpointId: startup.modelEndpointId ?? null,
					modelProtocol: startup.modelProtocol ?? null,
				});
				if (startup.permissionMode) {
					deps.agentState.permissionMode = startup.permissionMode;
				}
				if (startup.thinkingMode) {
					deps.agentState.thinkingMode = normalizeThinkingModeForAgent(
						startup.agentId as SessionAgentId,
						startup.thinkingMode,
					);
				}
				if (startup.ampAgentMode) {
					deps.agentState.ampAgentMode = startup.ampAgentMode;
				}
				if (startup.firstMessage?.trim() || (startup.initialImages?.length ?? 0) > 0) {
					const startupText = startup.firstMessage.trim();
					const startupImages = startup.initialImages ?? [];
					const startupChatId = chatId;
					queueMicrotask(() => {
						if (!deps.sessions.byId[startupChatId]) return;
						void this.submitForChat(startupChatId, startupText, startupImages);
					});
				}
			}
			return;
		}

		deps.lifecycle.setCurrentChatId(chatId);
		deps.composerState.restoreDraft(chatId);
		void this.#startQueueRefresh(chatId);

		if (
			selected.lastActivityAt &&
			(!selected.lastReadAt || selected.lastReadAt < selected.lastActivityAt)
		) {
			deps.readReceiptOutbox.enqueue(chatId, selected.lastActivityAt);
			deps.sessions.patchLastReadAt(chatId, selected.lastActivityAt);
		}

		deps.agentState.permissionMode = selected.permissionMode ?? 'default';
		deps.agentState.thinkingMode = normalizeThinkingModeForAgent(
			selected.agentId,
			selected.thinkingMode ?? 'none',
		);
		deps.agentState.ampAgentMode = selected.ampAgentMode ?? 'smart';

		this.loadChat(chatId, { minimumMessageLimit: restored?.count ?? 0 });
	}

	async loadChat(chatId: string, options: { minimumMessageLimit?: number } = {}): Promise<void> {
		const { deps } = this;
		let minimumMessageLimit =
			options.minimumMessageLimit ??
			Math.min(deps.chatState.chatMessages.length, INITIAL_VISIBLE_MESSAGES);

		// Restore from cache if no messages are loaded yet (e.g., WS reconnect path).
		// The primary restore happens earlier in handleChatSwitch.
		if (deps.chatState.chatMessages.length === 0) {
			const restored = deps.chatState.activateChat(chatId);
			minimumMessageLimit = Math.max(minimumMessageLimit, restored?.count ?? 0);
		}

		if (deps.chatState.chatMessages.length > 0) {
			requestAnimationFrame(() => deps.scrollToBottom());
		}

		try {
			await deps.chatState.loadMessages(chatId, {
				minimumLimit: minimumMessageLimit,
			});
			if (deps.sessions.selectedChatId !== chatId) return;

			deps.chatState.transcriptCache.markValidated(chatId);
			requestAnimationFrame(() => deps.scrollToBottom());

			const record = deps.sessions.byId[chatId];
			if (
				record?.lastActivityAt &&
				(!record.lastReadAt || record.lastReadAt < record.lastActivityAt)
			) {
				deps.readReceiptOutbox.enqueue(chatId, record.lastActivityAt);
				deps.sessions.patchLastReadAt(chatId, record.lastActivityAt);
			}
		} catch {
			// Leaves restored messages visible until reconnect or manual retry reloads them.
		}
	}

	// Submits a message for a specific chat. Accepts explicit chatId to
	// prevent selection-dependent races during draft startup.
	async submitForChat(
		chatId: string,
		messageOverride?: string,
		imageOverride?: File[],
	): Promise<void> {
		const { deps } = this;
		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) return;
		const isDraft = selected.status === 'draft';
		const startup = deps.sessions.startupByChatId[chatId];

		const text = messageOverride ?? deps.composerState.inputText.trim();
		const submissionImages = imageOverride ?? deps.composerState.images;
		if (!text && submissionImages.length === 0) return;
		const restoreComposerOnFailure = messageOverride === undefined && imageOverride === undefined;
		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		const renameCommand = parseRenameCommand(text);
		if (renameCommand) {
			await this.#slashCommands.submitRenameCommand(
				chatId,
				selected,
				renameCommand.title,
				[...submissionImages],
				restoreComposerOnFailure,
			);
			return;
		}
		const scheduleInCommand = parseScheduleInCommand(text);
		if (scheduleInCommand.kind !== 'not-command') {
			await this.#slashCommands.submitScheduleInCommand(
				chatId,
				selected,
				scheduleInCommand,
				[...submissionImages],
				restoreComposerOnFailure,
			);
			return;
		}

		const agentId = selected.agentId as SessionAgentId;
		const steerCommand = parseSteerCommand(text);
		if (steerCommand.kind !== 'not-command') {
			if (steerCommand.kind === 'invalid') {
				deps.chatState.appendLocalNotice('error', m.chat_notice_steer_prompt_required());
				return;
			}
			if (agentId !== 'codex') {
				deps.chatState.appendLocalNotice('error', m.chat_notice_steer_codex_only());
				return;
			}
			if (selected.status !== 'running' || !selected.isProcessing) {
				deps.chatState.appendLocalNotice('error', m.chat_notice_steer_requires_active_turn());
				return;
			}
		}
		if (deps.modelCatalog.supportsFork(agentId)) {
			const forkCommand = parseForkCommand(text);
			if (forkCommand) {
				const isProcessing = selected.status === 'running' && selected.isProcessing;
				if (isProcessing && !deps.modelCatalog.supportsForkWhileRunning(agentId)) {
					deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_processing());
					return;
				}
				await this.#slashCommands.submitForkCommand(
					chatId,
					selected,
					forkCommand.message,
					[...submissionImages],
					messageOverride === undefined && imageOverride === undefined,
				);
				return;
			}
		}

		const compactCommand = parseCompactCommand(text);
		if (compactCommand) {
			await this.#slashCommands.submitCompactCommand(
				chatId,
				selected,
				compactCommand.instructions,
				messageOverride === undefined && imageOverride === undefined,
			);
			return;
		}

		const activeTurn = selected.status === 'running' && selected.isProcessing;
		const pendingQueueRefresh = this.#queueRefreshByChatId.get(chatId);
		if (!isDraft && !activeTurn && pendingQueueRefresh) {
			await this.#settleQueueRefresh(pendingQueueRefresh);
		}
		const currentQueue = deps.conversationUi.getQueue(chatId);
		const shouldQueueInput =
			activeTurn || (currentQueue?.entries.length ?? 0) > 0 || currentQueue?.dispatchingEntryId != null;
		if (shouldQueueInput && submissionImages.length > 0) {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_queue_attachments_unavailable(),
			);
			return;
		}

		const ownsDraftSubmission = isDraft;
		if (ownsDraftSubmission) {
			if (deps.composerState.isSubmitting) return;
			deps.composerState.isSubmitting = true;
		}

		let imagePayload: ChatImage[] = [];
		if (submissionImages.length > 0) {
			try {
				imagePayload = await prepareChatImages(submissionImages);
			} catch (error) {
				console.error('[SessionController] Failed to prepare attachment payload:', error);
				if (ownsDraftSubmission) {
					deps.composerState.isSubmitting = false;
				}
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_prepare_attachments({ detail: errorDetail(error) }),
				);
				return;
			}
		}

		if (shouldQueueInput) {
			const activeDelivery =
				activeTurn &&
				(steerCommand.kind === 'valid' || (agentId === 'codex' && isCodexGoalCommand(text)));
			const content = steerCommand.kind === 'valid' ? steerCommand.prompt : text;
			const submissionSequence = this.#beginQueueSubmission(chatId);
			// Clear optimistically before awaiting the network, matching the
			// non-queue path. Clearing after the await would wipe any text the
			// user typed during the round-trip.
			if (restoreComposerOnFailure) {
				deps.composerState.clearAfterSubmit(chatId);
			}
			try {
				const result = await (activeDelivery ? sendActiveInput : createQueuedInput)({
					clientRequestId: createClientCommandId(),
					chatId,
					content,
				});
					deps.conversationUi.setMessageQueue(chatId, result.queue);
				} catch (err) {
					if (restoreComposerOnFailure) {
						this.#recordQueueSubmissionFailure(chatId, {
							sequence: submissionSequence,
							text: previousText,
							images: previousImages,
						});
					}
					deps.chatState.appendLocalNotice(
						'error',
						m.chat_notice_failed_queue_message({
							detail: errorDetail(err),
							content: restoreComposerOnFailure ? previousText : text,
						}),
					);
				} finally {
					this.#finishQueueSubmission(chatId);
				}
			return;
		}

		const clientRequestId = createClientCommandId();
		const clientMessageId = createClientCommandId();
		deps.chatState.upsertPendingUserInput(
			pendingUserInput(chatId, text, imagePayload, clientRequestId, clientMessageId),
		);
		deps.chatState.isUserScrolledUp = false;
		if (restoreComposerOnFailure) {
			deps.composerState.clearAfterSubmit(chatId);
		}
		if (!ownsDraftSubmission) {
			deps.composerState.isSubmitting = true;
		}

		if (isDraft) {
			deps.startupCoordinator.beginLocalStartup(chatId);
			const agentId = startup?.agentId ?? selected.agentId;
			const model = startup?.model ?? selected.model ?? deps.agentState.model;
			const apiProviderId =
				startup?.apiProviderId ?? selected.apiProviderId ?? deps.agentState.apiProviderId;
			const modelEndpointId =
				startup?.modelEndpointId ?? selected.modelEndpointId ?? deps.agentState.modelEndpointId;
			const modelProtocol =
				startup?.modelProtocol ?? selected.modelProtocol ?? deps.agentState.modelProtocol;
			const permissionMode = startup?.permissionMode ?? deps.agentState.permissionMode;
			const thinkingMode = startup?.thinkingMode ?? deps.agentState.thinkingMode;
			const claudeThinkingMode = startup?.claudeThinkingMode ?? deps.agentState.claudeThinkingMode;
			const ampAgentMode = startup?.ampAgentMode ?? deps.agentState.ampAgentMode;

			try {
				const response = await startChat({
					clientRequestId,
					clientMessageId,
					chatId,
					agentId: agentId as typeof deps.agentState.agentId,
					projectPath: selected.projectPath,
					model,
					apiProviderId,
					modelEndpointId,
					modelProtocol,
					permissionMode,
					thinkingMode,
					claudeThinkingMode,
					ampAgentMode,
					command: text,
					images: imagePayload.length > 0 ? imagePayload : undefined,
					tags: startup?.tags,
				});
				deps.sessions.applyStartEntry(response.chat);
				this.#markPendingUserInputDelivery(clientRequestId, 'accepted');
				if (response.status === 'accepted') {
					deps.lifecycle.beginTurn(chatId);
					deps.sessions.setChatProcessing(chatId, true);
				} else {
					deps.startupCoordinator.completeStartup(chatId);
				}
			} catch (err) {
				console.error('[SessionController] Failed to start chat:', err);
				this.#markPendingUserInputDelivery(clientRequestId, 'failed');
				deps.startupCoordinator.completeStartup(chatId);
				deps.lifecycle.clearTurnStatus();
				deps.sessions.setChatProcessing(chatId, false);
				if (restoreComposerOnFailure) {
					deps.composerState.inputText = previousText;
					deps.composerState.images = previousImages;
					deps.composerState.saveDraft(chatId);
				}
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_start_chat({ detail: errorDetail(err) }),
				);
			} finally {
				deps.composerState.isSubmitting = false;
			}
		} else {
			const selection = deps.modelCatalog.selectionFor(
				deps.agentState.agentId,
				deps.agentState.model,
				deps.agentState.modelEndpointId,
			);
			try {
				await runChat({
					clientRequestId,
					clientMessageId,
					chatId,
					command: text,
					images: imagePayload.length > 0 ? imagePayload : undefined,
					permissionMode: deps.agentState.permissionMode,
					thinkingMode: deps.agentState.thinkingMode,
					claudeThinkingMode: deps.agentState.claudeThinkingMode,
					ampAgentMode: deps.agentState.ampAgentMode,
					model: selection.model,
					apiProviderId: selection.apiProviderId,
					modelEndpointId: selection.modelEndpointId,
					modelProtocol: selection.modelProtocol,
				});
				this.#markPendingUserInputDelivery(clientRequestId, 'accepted');
				deps.lifecycle.beginTurn(chatId);
				deps.sessions.setChatProcessing(chatId, true);
			} catch (err) {
				this.#markPendingUserInputDelivery(clientRequestId, 'failed');
				deps.lifecycle.clearTurnStatus();
				deps.sessions.setChatProcessing(chatId, false);
				if (restoreComposerOnFailure) {
					deps.composerState.inputText = previousText;
					deps.composerState.images = previousImages;
					deps.composerState.saveDraft(chatId);
				}
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_send_message({ detail: errorDetail(err) }),
				);
			} finally {
				deps.composerState.isSubmitting = false;
			}
		}
	}

	// Forks a chat without sending a new message, then selects the fork. Backs
	// both the in-chat Fork button and the bare `/fork` command. For agents that
	// support it the server snapshots the transcript up to the last completed
	// turn, so this works while the source chat is still processing.
	forkChat(sourceChatId: string, upToSeq?: number): Promise<void> {
		return this.#slashCommands.forkChat(sourceChatId, upToSeq);
	}

	handleAbort(): Promise<void> {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return Promise.resolve();
		const previousLoadingStatus = deps.lifecycle.loadingStatus
			? { ...deps.lifecycle.loadingStatus }
			: null;
		const stoppingStatus = { text: m.chat_loading_stopping(), tokens: 0, can_interrupt: false };
		deps.lifecycle.setLoadingStatus(stoppingStatus);
		return stopChat({
			clientRequestId: createClientCommandId(),
			chatId,
			agentId: deps.agentState.agentId,
		})
			.then(() => {
				deps.lifecycle.clearTurnStatus();
				deps.sessions.setChatProcessing(chatId, false);
			})
			.catch((error) => {
				const currentLoadingStatus = deps.lifecycle.loadingStatus;
				if (
					currentLoadingStatus?.text === stoppingStatus.text &&
					currentLoadingStatus.tokens === stoppingStatus.tokens &&
					currentLoadingStatus.can_interrupt === stoppingStatus.can_interrupt
				) {
					deps.lifecycle.setLoadingStatus(previousLoadingStatus);
				}
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_stop_chat({ detail: errorDetail(error) }),
				);
			});
	}

	handlePermissionDecision(permissionRequestId: string, decision: PermissionDecisionPayload): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void sendPermissionDecision({
			clientRequestId: createClientCommandId(),
			chatId,
			permissionRequestId,
			allow: decision.allow,
			alwaysAllow: Boolean(decision.alwaysAllow),
			response: decision.response,
		})
			.then(() => {
				deps.conversationUi.setPendingPermissionRequests(
					deps.conversationUi.pendingPermissionRequests.filter(
						(r) => r.permissionRequestId !== permissionRequestId,
					),
				);
			})
			.catch((error) => {
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_permission_decision({ detail: errorDetail(error) }),
				);
			});
	}

	handleExitPlanMode(permissionRequestId: string, choice: string, plan: string): void {
		const { deps } = this;
		deps.conversationUi.setPendingPermissionRequests(
			deps.conversationUi.pendingPermissionRequests.filter(
				(r) => r.permissionRequestId !== permissionRequestId,
			),
		);

		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		const path = deps.sessions.selectedChat?.projectPath;

		const buildApprovalMessage = () =>
			`User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n${plan}`;

		const resumeWithApproval = (mode: PermissionMode) => {
			deps.conversationUi.setPreviousPermissionMode(null);
			deps.agentState.permissionMode = mode;
			if (!chatId || !path) return;
			const selection = deps.modelCatalog.selectionFor(
				deps.agentState.agentId,
				deps.agentState.model,
				deps.agentState.modelEndpointId,
			);

			void runChat({
				clientRequestId: createClientCommandId(),
				clientMessageId: createClientCommandId(),
				chatId,
				command: buildApprovalMessage(),
				permissionMode: mode,
				thinkingMode: deps.agentState.thinkingMode,
				claudeThinkingMode: deps.agentState.claudeThinkingMode,
				ampAgentMode: deps.agentState.ampAgentMode,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			})
				.then(() => {
					deps.lifecycle.beginTurn(chatId);
					deps.sessions.setChatProcessing(chatId, true);
				})
				.catch((error) => {
					deps.chatState.appendLocalNotice(
						'error',
						m.chat_notice_failed_resume_plan({ detail: errorDetail(error) }),
					);
				});
		};

		switch (choice) {
			case 'bypass-new': {
				const restoreMode = deps.conversationUi.previousPermissionMode || 'default';
				deps.conversationUi.setPreviousPermissionMode(null);
				deps.agentState.permissionMode = restoreMode;

				const planMessage = `Implement the following plan:\n\n${plan}`;
				deps.appShell.openNewChatDialog({ prefill: planMessage });
				break;
			}
			case 'bypass':
				resumeWithApproval('bypassPermissions');
				break;
			case 'approve-edits':
				resumeWithApproval('acceptEdits');
				break;
			case 'deny': {
				if (chatId) {
					void sendPermissionDecision({
						clientRequestId: createClientCommandId(),
						chatId,
						permissionRequestId,
						allow: false,
						alwaysAllow: false,
					}).catch((error) => {
						deps.chatState.appendLocalNotice(
							'error',
							m.chat_notice_failed_deny_permission({ detail: errorDetail(error) }),
						);
					});
				}
				break;
			}
		}
	}

	handleQueueResume(): Promise<void> {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return Promise.resolve();
		return this.resumeQueueForChat(chatId).catch((error) => {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_resume_queue({ detail: errorDetail(error) }),
			);
		});
	}

	async resumeQueueForChat(chatId: string): Promise<void> {
		const result = await resumeChatQueue(chatId);
		this.deps.conversationUi.setMessageQueue(chatId, result.queue);
	}

	async createQueueEntryForChat(chatId: string, content: string): Promise<void> {
		try {
			const result = await createQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				content,
			});
			this.deps.conversationUi.setMessageQueue(chatId, result.queue);
		} catch (error) {
			const queue = queueFromMutationError(error);
			if (queue) this.deps.conversationUi.setMessageQueue(chatId, queue);
			throw error;
		}
	}

	async replaceQueueEntryForChat(
		chatId: string,
		entryId: string,
		content: string,
		expectedRevision: number,
	): Promise<void> {
		try {
			const result = await replaceQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				entryId,
				content,
				expectedRevision,
			});
			this.deps.conversationUi.setMessageQueue(chatId, result.queue);
		} catch (error) {
			const queue = queueFromMutationError(error);
			if (queue) this.deps.conversationUi.setMessageQueue(chatId, queue);
			throw error;
		}
	}

	async deleteQueueEntryForChat(chatId: string, entryId: string): Promise<void> {
		try {
			const result = await deleteQueuedInput({
				clientRequestId: createClientCommandId(),
				chatId,
				entryId,
			});
			this.deps.conversationUi.setMessageQueue(chatId, result.queue);
		} catch (error) {
			const queue = queueFromMutationError(error);
			if (queue) this.deps.conversationUi.setMessageQueue(chatId, queue);
			throw error;
		}
	}

	async handleDeleteQueuedInput(entryId: string): Promise<void> {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		try {
			await this.deleteQueueEntryForChat(chatId, entryId);
		} catch (error) {
			if (isDepartedQueueEntryError(error)) return;
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_remove_queued_message({ detail: errorDetail(error) }),
			);
		}
	}

	// Entry point for the composer model selector. Same-agent selections keep the
	// existing model-switch behavior; cross-agent selections continue the chat
	// under a new agent, seeding a fresh runtime from the canonical transcript.
	handleModelSelectionChange(next: AgentSwitchSelection): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		const currentAgentId = deps.sessions.selectedChat?.agentId ?? deps.agentState.agentId;
		if (next.agentId === currentAgentId) {
			this.handleModelChange(next.modelValue);
			return;
		}
		void this.#agentSwitch.switchAgent(chatId, next);
	}

	handleModelChange(model: string): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		const agentId = deps.agentState.agentId;
		const selection = deps.modelCatalog.selectionFor(agentId, model);
		if (deps.sessions.isDraft(chatId)) {
			deps.agentState.setModelSelection({
				model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			deps.sessions.patchDraftStartup(chatId, {
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			deps.sessions.patchChat(chatId, {
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			return;
		}

		// Block switching between local and cloud models within an active
		// session. The CLI conversation history contains agent-specific
		// artifacts (e.g. thinking-block signatures) that are invalid when
		// replayed against a different backend.
		const currentModel = deps.sessions.selectedChat?.model ?? deps.agentState.model;
		const currentEndpointId =
			deps.sessions.selectedChat?.modelEndpointId ?? deps.agentState.modelEndpointId;
		const wasLocal = deps.modelCatalog.isLocalModel(agentId, currentModel, currentEndpointId);
		const isLocal = deps.modelCatalog.isLocalModel(agentId, model, selection.modelEndpointId);
		if (wasLocal !== isLocal) {
			const target = isLocal ? m.chat_model_kind_local() : m.chat_model_kind_cloud();
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_cannot_switch_model_mid_session({ target, model: selection.model }),
			);
			return;
		}

		const previousModel = deps.sessions.selectedChat?.model ?? deps.agentState.model;
		const previousApiProviderId =
			deps.sessions.selectedChat?.apiProviderId ?? deps.agentState.apiProviderId;
		const previousEndpointId =
			deps.sessions.selectedChat?.modelEndpointId ?? deps.agentState.modelEndpointId;
		const previousProtocol =
			deps.sessions.selectedChat?.modelProtocol ?? deps.agentState.modelProtocol;
		deps.agentState.setModelSelection({
			model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		void updateChatModel({
			chatId,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		}).catch((error) => {
			deps.agentState.setModelSelection({
				model: deps.modelCatalog.selectionValueFor(agentId, previousModel, previousEndpointId),
				apiProviderId: previousApiProviderId ?? null,
				modelEndpointId: previousEndpointId ?? null,
				modelProtocol: previousProtocol ?? null,
			});
			deps.sessions.patchChat(chatId, {
				model: previousModel,
				apiProviderId: previousApiProviderId ?? null,
				modelEndpointId: previousEndpointId ?? null,
				modelProtocol: previousProtocol ?? null,
			});
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_model({ detail: errorDetail(error) }),
			);
		});
		deps.sessions.patchChat(chatId, {
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
	}

	handlePermissionModeChange(mode: PermissionMode): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		if (deps.sessions.isDraft(chatId)) {
			deps.sessions.patchDraftStartup(chatId, { permissionMode: mode });
			deps.sessions.patchChat(chatId, { permissionMode: mode });
			return;
		}
		const previous = deps.sessions.selectedChat?.permissionMode ?? 'default';
		deps.sessions.patchChat(chatId, { permissionMode: mode });
		void updateExecutionSettings({ chatId, permissionMode: mode }).catch((error) => {
			deps.agentState.permissionMode = previous;
			deps.sessions.patchChat(chatId, { permissionMode: previous });
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_permission_mode({ detail: errorDetail(error) }),
			);
		});
	}

	handleThinkingModeChange(mode: ThinkingMode): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		if (deps.sessions.isDraft(chatId)) {
			deps.sessions.patchDraftStartup(chatId, { thinkingMode: mode });
			deps.sessions.patchChat(chatId, { thinkingMode: mode });
			return;
		}
		const previous = deps.sessions.selectedChat?.thinkingMode ?? 'none';
		deps.sessions.patchChat(chatId, { thinkingMode: mode });
		void updateExecutionSettings({ chatId, thinkingMode: mode }).catch((error) => {
			deps.agentState.thinkingMode = normalizeThinkingModeForAgent(
				deps.agentState.agentId,
				previous,
			);
			deps.sessions.patchChat(chatId, { thinkingMode: previous });
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_thinking_mode({ detail: errorDetail(error) }),
			);
		});
	}

	handleAmpAgentModeChange(mode: AmpAgentMode): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		if (deps.sessions.isDraft(chatId)) {
			deps.sessions.patchDraftStartup(chatId, { ampAgentMode: mode });
			deps.sessions.patchChat(chatId, { ampAgentMode: mode });
			return;
		}
		const previous = deps.sessions.selectedChat?.ampAgentMode ?? 'smart';
		deps.sessions.patchChat(chatId, { ampAgentMode: mode });
		void updateExecutionSettings({ chatId, ampAgentMode: mode }).catch((error) => {
			deps.agentState.ampAgentMode = previous;
			deps.sessions.patchChat(chatId, { ampAgentMode: previous });
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_update_agent_mode({ detail: errorDetail(error) }),
			);
		});
	}
}
