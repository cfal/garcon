// Chat session controller. Owns chat lifecycle transitions, message
// submission, permission decisions, queue control, and mode persistence.
// No direct DOM access -- all viewport operations are delegated via
// callback functions supplied through the deps interface.

import {
	sendPermissionDecision,
	stopChat,
	interruptAndSendChat,
} from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import type { ChatImage } from '$shared/chat-types';
import { createClientCommandId } from '$lib/chat/conversation/client-command-id.js';
import { CommandOutcomeUnknownError } from '$lib/chat/conversation/idempotent-command.js';
import {
	INITIAL_VISIBLE_MESSAGES,
	type ActiveTranscriptPort,
} from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { ComposerState } from '$lib/chat/composer/composer.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { AgentSettingDescriptor, AgentSettingsEnvelope } from '$shared/agent-integration';
import type { JsonValue } from '$shared/json';
import {
	normalizeSupportedPermissionMode,
	normalizeSupportedThinkingMode,
} from '$lib/agents/agent-modes.js';
import type { SessionAgentId } from '$lib/types/app';
import type { ApiProtocol } from '$shared/api-providers';
import type {
	PermissionDecisionPayload,
} from '$shared/chat-command-contracts';
import {
	ConversationAgentSwitchService,
	type AgentSwitchSelection,
} from '$lib/chat/conversation/conversation-agent-switch-service.js';
import { ConversationSlashCommandService } from '$lib/chat/conversation/conversation-slash-command-service.js';
import { ConversationQueueController } from '$lib/chat/conversation/conversation-queue-controller.svelte.js';
import { ConversationSettingsController } from '$lib/chat/conversation/conversation-settings-controller.svelte.js';
import { AcceptedInputSubmissionService } from '$lib/chat/conversation/accepted-input-submission-service.js';
import type { ConversationSubmissionOutcome } from '$lib/chat/conversation/conversation-submission-outcome.js';
import { classifySubmission } from '$lib/chat/conversation/submission-classifier.js';
import {
	errorDetail,
	prepareChatImages,
} from '$lib/chat/conversation/conversation-submission-helpers.js';
import {
	submitDraftRoute,
	submitQueueRoute,
	submitRunRoute,
} from '$lib/chat/conversation/submission-routes.js';
import * as m from '$lib/paraglide/messages.js';

type SessionTranscriptState = Pick<
	ActiveTranscriptPort,
	| 'activeChatId'
	| 'chatMessages'
	| 'isUserScrolledUp'
	| 'activateChat'
	| 'appendLocalNotice'
	| 'clearPendingUserInput'
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
	| 'agentSettings'
	| 'setAgentId'
	| 'setAgentSettings'
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
	ConversationUiPort,
	| 'pendingPermissionRequests'
	| 'previousPermissionMode'
	| 'clearPendingPermissionRequests'
	| 'getExecutionControl'
	| 'setExecutionControl'
	| 'setExecutionControlFromRefresh'
	| 'setPendingPermissionRequests'
	| 'setPreviousPermissionMode'
>;

type SessionStartupCoordinator = Pick<StartupCoordinator, 'beginLocalStartup' | 'completeStartup'>;

export interface SessionControllerDeps {
	sessions: Pick<
		ChatSessionsPort,
		| 'selectedChatId'
		| 'selectedChat'
		| 'byId'
		| 'startupByChatId'
		| 'isDraft'
		| 'patchDraftStartup'
		| 'patchChat'
		| 'patchLastReadAt'
		| 'applyStartEntry'
		| 'applyProcessingEvent'
		| 'upsertServerChat'
		| 'setSelectedChatId'
		| 'renameChat'
	>;
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
		getDefaultAgentSettings: (agentId: SessionAgentId) => AgentSettingsEnvelope;
		getPermissionModes: (agentId: SessionAgentId) => readonly PermissionMode[];
		getThinkingModes: (agentId: SessionAgentId) => readonly ThinkingMode[];
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

function isExecutionControlAdmissionConflict(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.retryable &&
		error.errorCode === 'SESSION_BUSY'
	);
}

export class ConversationSessionController {
	#lastChatId: string | null = null;
	readonly #slashCommands: ConversationSlashCommandService;
	readonly #agentSwitch: ConversationAgentSwitchService;
	readonly #acceptedInputs: AcceptedInputSubmissionService;
	readonly #queue: ConversationQueueController;
	readonly #settings: ConversationSettingsController;

	constructor(private deps: SessionControllerDeps) {
		this.#acceptedInputs = new AcceptedInputSubmissionService();
		this.#slashCommands = new ConversationSlashCommandService(deps, this.#acceptedInputs);
		this.#agentSwitch = new ConversationAgentSwitchService(deps);
		const acceptedInputs = this.#acceptedInputs;
		const agentSwitch = this.#agentSwitch;
		this.#queue = new ConversationQueueController({
			get sessions() { return deps.sessions; },
			get chatState() { return deps.chatState; },
			get composerState() { return deps.composerState; },
			get lifecycle() { return deps.lifecycle; },
			get conversationUi() { return deps.conversationUi; },
			get acceptedInputs() { return acceptedInputs; },
		});
		this.#settings = new ConversationSettingsController({
			get sessions() { return deps.sessions; },
			get agentState() { return deps.agentState; },
			get modelCatalog() { return deps.modelCatalog; },
			get chatState() { return deps.chatState; },
			get agentSwitch() { return agentSwitch; },
		});
	}

	#executionModelSelection(): {
		model: string;
		apiProviderId: string | null;
		modelEndpointId: string | null;
		modelProtocol: ApiProtocol | null;
	} {
		const { agentState, modelCatalog } = this.deps;
		const resolved = modelCatalog.selectionFor(
			agentState.agentId,
			agentState.model,
			agentState.modelEndpointId,
		);
		if (resolved.modelEndpointId || !agentState.modelEndpointId) return resolved;
		return {
			model: resolved.model,
			apiProviderId: agentState.apiProviderId,
			modelEndpointId: agentState.modelEndpointId,
			modelProtocol: agentState.modelProtocol,
		};
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
				const startupAgentId = startup.agentId as SessionAgentId;
				deps.agentState.permissionMode = normalizeSupportedPermissionMode(
					startup.permissionMode,
					deps.modelCatalog.getPermissionModes(startupAgentId),
				);
				deps.agentState.thinkingMode = normalizeSupportedThinkingMode(
					startup.thinkingMode,
					deps.modelCatalog.getThinkingModes(startupAgentId),
				);
				deps.agentState.setAgentSettings(startup.agentSettings);
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
		void this.#queue.startControlRefresh(chatId);

		if (
			selected.lastActivityAt &&
			(!selected.lastReadAt || selected.lastReadAt < selected.lastActivityAt)
		) {
			deps.readReceiptOutbox.enqueue(chatId, selected.lastActivityAt);
			deps.sessions.patchLastReadAt(chatId, selected.lastActivityAt);
		}

		deps.agentState.permissionMode = normalizeSupportedPermissionMode(
			selected.permissionMode,
			deps.modelCatalog.getPermissionModes(selected.agentId),
		);
		deps.agentState.thinkingMode = normalizeSupportedThinkingMode(
			selected.thinkingMode,
			deps.modelCatalog.getThinkingModes(selected.agentId),
		);
		deps.agentState.setAgentSettings(selected.agentSettings);

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

	// Accepts an explicit chat ID so draft startup cannot race selection changes.
	async submitForChat(chatId: string, messageOverride?: string, imageOverride?: File[]): Promise<ConversationSubmissionOutcome> {
		const { deps } = this;
		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) return 'no-op';
		const text = messageOverride ?? deps.composerState.inputText.trim();
		const submissionImages = imageOverride ?? deps.composerState.images;
		if (!text && submissionImages.length === 0) return 'no-op';

		const restoreComposerOnFailure = messageOverride === undefined && imageOverride === undefined;
		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		const slash = this.#slashCommands.dispatchSubmission({
			chatId,
			chat: selected,
			text,
			images: [...submissionImages],
			ownsComposer: restoreComposerOnFailure,
		});
		if (slash.kind === 'handled') return slash.outcome;

		const isDraft = selected.status === 'draft';
		const activeTurn = selected.status === 'running' && selected.isProcessing;
		const pendingControlRefresh = this.#queue.pendingControlRefresh(chatId);
		if (!isDraft && !activeTurn && pendingControlRefresh) {
			await this.#queue.settleControlRefresh(pendingControlRefresh);
		}
		const route = classifySubmission({
			isDraft,
			isProcessing: activeTurn,
			control: deps.conversationUi.getExecutionControl(chatId),
			isActiveDeliveryInput: slash.isActiveDeliveryInput,
			hasAttachments: submissionImages.length > 0,
		});
		if (route === 'queue-attachments-unsupported') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_queue_attachments_unavailable());
			return 'rejected';
		}

		if (route === 'draft') {
			if (deps.composerState.isSubmitting) return 'no-op';
			deps.composerState.isSubmitting = true;
		}
		let imagePayload: ChatImage[] = [];
		try {
			if (submissionImages.length > 0) imagePayload = await prepareChatImages(submissionImages);
		} catch (error) {
			console.error('[SessionController] Failed to prepare attachment payload:', error);
			if (route === 'draft') deps.composerState.isSubmitting = false;
			deps.chatState.appendLocalNotice('error', m.chat_notice_failed_prepare_attachments({
				detail: errorDetail(error),
			}));
			return 'rejected';
		}

		const context = {
			chatId,
			chat: selected,
			startup: deps.sessions.startupByChatId[chatId],
			text,
			content: slash.content,
			images: imagePayload,
			previousText,
			previousImages,
			restoreComposerOnFailure,
		};
		if (route === 'queue' || route === 'active') {
			return submitQueueRoute(deps, this.#acceptedInputs, this.#queue, context, route);
		}
		if (route === 'draft') return submitDraftRoute(deps, this.#acceptedInputs, context);
		return submitRunRoute(
			deps,
			this.#acceptedInputs,
			this.#queue,
			context,
			this.#executionModelSelection(),
		);
	}

	// Forks a chat without sending a new message, then selects the fork. Backs
	// both the in-chat Fork button and the bare `/fork` command. For agents that
	// support it the server snapshots the transcript up to the last completed
	// turn, so this works while the source chat is still processing.
	forkChat(sourceChatId: string, upToSeq?: number): Promise<void> {
		return this.#slashCommands.forkChat(sourceChatId, upToSeq);
	}

	handleAbort(): Promise<void> {
		const { conversationUi } = this.deps;
		return this.#requestTurnStop(stopChat, (chatId, result) => {
			conversationUi.setExecutionControl(chatId, result.control);
		});
	}

	handleInterruptAndSend(): Promise<void> {
		const { conversationUi } = this.deps;
		return this.#requestTurnStop(interruptAndSendChat, (chatId, result) => {
			conversationUi.setExecutionControl(chatId, result.control);
		});
	}

	#requestTurnStop<T extends { stopped: boolean }>(
		request: (input: Parameters<typeof stopChat>[0]) => Promise<T>,
		onResult?: (chatId: string, result: T) => void,
	): Promise<void> {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return Promise.resolve();
		const previousLoadingStatus = deps.lifecycle.loadingStatus
			? { ...deps.lifecycle.loadingStatus }
			: null;
		const stoppingStatus = { text: m.chat_loading_stopping(), tokens: 0, can_interrupt: false };
		const restorePreviousStatus = () => {
			const currentLoadingStatus = deps.lifecycle.loadingStatus;
			if (
				currentLoadingStatus?.text === stoppingStatus.text &&
				currentLoadingStatus.tokens === stoppingStatus.tokens &&
				currentLoadingStatus.can_interrupt === stoppingStatus.can_interrupt
			) {
				deps.lifecycle.setLoadingStatus(previousLoadingStatus);
			}
		};
		deps.lifecycle.setLoadingStatus(stoppingStatus);
		return request({
			clientRequestId: createClientCommandId(),
			chatId,
			agentId: deps.agentState.agentId,
		})
			.then((result) => {
				onResult?.(chatId, result);
				if (!result.stopped) {
					restorePreviousStatus();
					deps.chatState.appendLocalNotice(
						'error',
						m.chat_notice_failed_stop_chat({ detail: m.chat_notice_stop_not_active() }),
					);
					return;
				}
				deps.lifecycle.clearTurnStatus();
			})
			.catch((error) => {
				restorePreviousStatus();
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
			const selection = this.#executionModelSelection();

			const submission = this.#acceptedInputs.run({
				chatId,
				command: buildApprovalMessage(),
				permissionMode: mode,
				thinkingMode: deps.agentState.thinkingMode,
				agentSettings: deps.agentState.agentSettings,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			void submission
				.submit()
				.then(() => {
					deps.lifecycle.beginTurn(chatId);
				})
				.catch(async (error) => {
					if (isExecutionControlAdmissionConflict(error)) {
						await this.#queue.settleControlRefresh(this.#queue.startControlRefresh(chatId));
					}
					deps.chatState.appendLocalNotice(
						'error',
						error instanceof CommandOutcomeUnknownError
							? m.chat_notice_delivery_outcome_unconfirmed()
							: m.chat_notice_failed_resume_plan({ detail: errorDetail(error) }),
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

	handleQueuePause(): Promise<void> {
		return this.#queue.handlePause();
	}

	handleQueueResume(pauseId: string): Promise<void> {
		return this.#queue.handleResume(pauseId);
	}

	handleQueueControlError(action: 'pause' | 'resume', error: unknown): void {
		this.#queue.handleControlError(action, error);
	}

	async pauseQueueForChat(chatId: string): Promise<void> {
		await this.#queue.pauseForChat(chatId);
	}

	async resumeQueueForChat(chatId: string, pauseId: string): Promise<void> {
		await this.#queue.resumeForChat(chatId, pauseId);
	}

	async createQueueEntryForChat(chatId: string, content: string): Promise<void> {
		await this.#queue.createForChat(chatId, content);
	}

	async replaceQueueEntryForChat(
		chatId: string,
		entryId: string,
		content: string,
		expectedRevision: number,
	): Promise<void> {
		await this.#queue.replaceForChat(chatId, entryId, content, expectedRevision);
	}

	async deleteQueueEntryForChat(chatId: string, entryId: string): Promise<void> {
		await this.#queue.deleteForChat(chatId, entryId);
	}

	async handleDeleteQueuedInput(entryId: string): Promise<void> {
		await this.#queue.handleDelete(entryId);
	}

	handleModelSelectionChange(next: AgentSwitchSelection): void {
		this.#settings.handleModelSelectionChange(next);
	}

	handleModelChange(model: string): void {
		this.#settings.handleModelChange(model);
	}

	handlePermissionModeChange(mode: PermissionMode): void {
		this.#settings.handlePermissionModeChange(mode);
	}

	handleThinkingModeChange(mode: ThinkingMode): void {
		this.#settings.handleThinkingModeChange(mode);
	}

	handleAgentSettingChange(descriptor: AgentSettingDescriptor, value: JsonValue): void {
		this.#settings.handleAgentSettingChange(descriptor, value);
	}
}
