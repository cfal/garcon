// Chat session controller. Owns chat lifecycle transitions, message
// submission, permission decisions, queue control, and mode persistence.
// No direct DOM access -- all viewport operations are delegated via
// callback functions supplied through the deps interface.

import {
	compactChat,
	dequeueChatMessage,
	enqueueChatMessage,
	forkChat,
	forkRunChat,
	getChatQueue,
	pauseChatQueue,
	resumeChatQueue,
	runChat,
	sendPermissionDecision,
	startChat,
	stopChat,
	updateChatAgentModel,
	updateChatModel,
	updateExecutionSettings,
} from '$lib/api/chats.js';
import type { ChatImage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import { mimeTypeForChatAttachment } from '$lib/chat/image-attachment.svelte';
import { createClientChatId } from '$lib/chat/client-id';
import { createClientCommandId } from '$lib/chat/client-command-id';
import { parseForkCommand } from '$lib/chat/fork-command';
import { parseCompactCommand } from '$lib/chat/slash-commands';
import { INITIAL_VISIBLE_MESSAGES, type ChatState } from '$lib/chat/state.svelte';
import type { ComposerState } from '$lib/chat/composer.svelte';
import type { AgentState } from '$lib/chat/agent-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { AmpAgentMode, ClaudeThinkingMode, PermissionMode, ThinkingMode } from '$lib/types/chat';
import type { ChatSessionRecord, ChatStartupConfig } from '$lib/types/chat-session';
import type { AppTab, SessionAgentId } from '$lib/types/app';
import type { ApiProtocol } from '$shared/api-providers';
import type { PermissionDecisionPayload } from '$shared/chat-command-contracts';
import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
import * as m from '$lib/paraglide/messages.js';

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
		promoteDraft: (chatId: string) => void;
		setChatProcessing: (chatId: string, isProcessing: boolean) => void;
		setSelectedChatId: (id: string | null) => void;
		quietRefreshChats: () => Promise<void> | void;
	};
	chatState: ChatState;
	composerState: ComposerState;
	agentState: AgentState;
	lifecycle: ChatLifecycleStore;
	conversationUi: ConversationUiStore;
	startupCoordinator: StartupCoordinator;
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
	navigation: { setActiveTab: (tab: AppTab) => void; navigateToChat?: (chatId: string) => void };
	/** Rebuilds the chat transcript from native history (e.g. after an agent switch). */
	reloadTranscript?: (chatId: string) => Promise<void>;
	setIsViewportPinnedToBottom: (v: boolean) => void;
	setInitialBottomRestorePending: (chatId: string | null) => void;
	scrollToBottom: () => void;
}

async function fileToChatImage(file: File): Promise<ChatImage> {
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
			} else {
				reject(new Error('Failed to read attachment data URL'));
			}
		};
		reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'));
		reader.onabort = () => reject(new Error('Attachment read aborted'));
		reader.readAsDataURL(file);
	});
	return { data, name: file.name, mimeType: mimeTypeForChatAttachment(file) };
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pendingUserInput(
	chatId: string,
	content: string,
	images: ChatImage[],
	clientRequestId: string,
	clientMessageId: string,
): PendingUserInput {
	return {
		chatId,
		clientRequestId,
		clientMessageId,
		content,
		createdAt: new Date().toISOString(),
		deliveryStatus: 'submitting',
		...(images.length > 0 ? { images } : {}),
	};
}

export class ConversationSessionController {
	#lastChatId: string | null = null;

	constructor(private deps: SessionControllerDeps) {}

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

	// Deduplicates chat-switch calls so the component effect can be stateless.
	handleChatSwitchIfChanged(chatId: string | null): void {
		if (chatId === this.#lastChatId) return;
		this.#lastChatId = chatId;
		this.handleChatSwitch(chatId);
	}

	// Resets per-chat state and loads messages when the selected chat changes.
	handleChatSwitch(chatId: string | null): void {
		const { deps } = this;
		deps.navigation.setActiveTab('chat');

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
					deps.agentState.thinkingMode = startup.thinkingMode;
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
		getChatQueue(chatId)
			.then((result) => {
				if (deps.sessions.selectedChatId === chatId) {
					deps.conversationUi.setMessageQueueFromRefresh(chatId, result.queue);
				}
			})
			.catch(() => {
				// Queue state will refresh through later broadcasts or reconnect reconciliation.
			});

		if (
			selected.lastActivityAt &&
			(!selected.lastReadAt || selected.lastReadAt < selected.lastActivityAt)
		) {
			deps.readReceiptOutbox.enqueue(chatId, selected.lastActivityAt);
			deps.sessions.patchLastReadAt(chatId, selected.lastActivityAt);
		}

		deps.agentState.permissionMode = selected.permissionMode ?? 'default';
		deps.agentState.thinkingMode = selected.thinkingMode ?? 'none';
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

		const agentId = selected.agentId as SessionAgentId;
		if (deps.modelCatalog.supportsFork(agentId)) {
			const forkCommand = parseForkCommand(text);
			if (forkCommand) {
				const isProcessing = selected.status === 'running' && selected.isProcessing;
				if (isProcessing && !deps.modelCatalog.supportsForkWhileRunning(agentId)) {
					deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_processing());
					return;
				}
				await this.#submitForkCommand(
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
			await this.#submitCompactCommand(
				chatId,
				selected,
				compactCommand.instructions,
				messageOverride === undefined && imageOverride === undefined,
			);
			return;
		}

		if (selected.status === 'running' && selected.isProcessing && submissionImages.length > 0) {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_queue_attachments_unavailable_while_running(),
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
				imagePayload = await Promise.all(submissionImages.map(fileToChatImage));
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

		if (selected.status === 'running' && selected.isProcessing) {
			// Clear optimistically before awaiting the network, matching the
			// non-queue path. Clearing after the await would wipe any text the
			// user typed during the round-trip.
			if (restoreComposerOnFailure) {
				deps.composerState.clearAfterSubmit(chatId);
			}
			try {
				const result = await enqueueChatMessage({
					clientRequestId: createClientCommandId(),
					chatId,
					content: text,
				});
				deps.chatState.clearLocalNotices();
				deps.conversationUi.setMessageQueue(chatId, result.queue);
			} catch (err) {
				if (restoreComposerOnFailure) {
					deps.composerState.inputText = previousText;
					deps.composerState.images = previousImages;
					deps.composerState.saveDraft(chatId);
				}
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_queue_message({ detail: errorDetail(err) }),
				);
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
				await startChat({
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
					tags: startup?.tags,
					options: {
						cwd: selected.projectPath,
						projectPath: selected.projectPath,
						sessionId: chatId,
						images: imagePayload,
					},
				});
				this.#markPendingUserInputDelivery(clientRequestId, 'accepted');
				deps.lifecycle.beginTurn(chatId);
				deps.sessions.setChatProcessing(chatId, true);
				deps.sessions.promoteDraft(chatId);
				deps.sessions.quietRefreshChats();
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

	// Routes `/compact` to the agent's native compaction via the dedicated
	// endpoint. The resulting CompactionMessage streams back over WebSocket.
	async #submitCompactCommand(
		chatId: string,
		chat: ChatSessionRecord,
		instructions: string,
		clearComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		if (chat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_compact_draft());
			return;
		}

		const previousText = deps.composerState.inputText;
		if (clearComposer) {
			deps.composerState.clearAfterSubmit(chatId);
		}

		try {
			await compactChat({
				chatId,
				clientRequestId: createClientCommandId(),
				instructions: instructions || undefined,
			});
		} catch (error) {
			if (clearComposer) {
				deps.composerState.inputText = previousText;
				deps.composerState.saveDraft(chatId);
			}
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_compact({ detail: errorDetail(error) }),
			);
		}
	}

	async #submitForkCommand(
		sourceChatId: string,
		sourceChat: ChatSessionRecord,
		message: string,
		images: File[],
		clearComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		if (sourceChat.status !== 'running') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_draft());
			return;
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		deps.chatState.appendLocalNotice('progress', m.chat_notice_forking_chat());
		deps.chatState.isUserScrolledUp = false;
		if (clearComposer) {
			deps.composerState.clearAfterSubmit(sourceChatId);
		}

		if (!message.trim()) {
			await this.#submitForkOnlyCommand(sourceChatId, previousText, previousImages, clearComposer);
			return;
		}

		let imagePayload: ChatImage[] = [];
		if (images.length > 0) {
			try {
				imagePayload = await Promise.all(images.map(fileToChatImage));
			} catch (error) {
				if (clearComposer) {
					deps.composerState.inputText = previousText;
					deps.composerState.images = previousImages;
					deps.composerState.saveDraft(sourceChatId);
				}
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_prepare_attachments({ detail: errorDetail(error) }),
				);
				return;
			}
		}

		const forkChatId = createClientChatId();
		const model = sourceChat.model ?? deps.agentState.model;
		const selection = deps.modelCatalog.selectionFor(
			sourceChat.agentId,
			model,
			sourceChat.modelEndpointId,
		);
		try {
			await forkRunChat({
				clientRequestId: createClientCommandId(),
				clientMessageId: createClientCommandId(),
				sourceChatId,
				chatId: forkChatId,
				command: message.trim(),
				permissionMode: sourceChat.permissionMode,
				thinkingMode: sourceChat.thinkingMode,
				claudeThinkingMode: sourceChat.claudeThinkingMode,
				ampAgentMode: sourceChat.ampAgentMode,
				images: imagePayload.length > 0 ? imagePayload : undefined,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});
			await deps.sessions.quietRefreshChats();
			deps.lifecycle.beginTurn(forkChatId);
			deps.sessions.setSelectedChatId(forkChatId);
			deps.sessions.setChatProcessing(forkChatId, true);
			deps.navigation.navigateToChat?.(forkChatId);
		} catch (error) {
			if (clearComposer) {
				deps.composerState.inputText = previousText;
				deps.composerState.images = previousImages;
				deps.composerState.saveDraft(sourceChatId);
			}
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
		}
	}

	// Forks a chat without sending a new message, then selects the fork. Backs
	// both the in-chat Fork button and the bare `/fork` command. For agents that
	// support it the server snapshots the transcript up to the last completed
	// turn, so this works while the source chat is still processing.
	async forkChat(sourceChatId: string, upToSeq?: number): Promise<void> {
		const { deps } = this;
		const sourceChat = deps.sessions.byId[sourceChatId];
		if (!sourceChat || sourceChat.status === 'draft') {
			deps.chatState.appendLocalNotice('error', m.chat_notice_cannot_fork_draft());
			return;
		}
		try {
			await this.#performForkOnly(sourceChatId, upToSeq);
		} catch (error) {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
		}
	}

	async #performForkOnly(sourceChatId: string, upToSeq?: number): Promise<void> {
		const { deps } = this;
		const result = await forkChat({
			sourceChatId,
			chatId: createClientChatId(),
			...(upToSeq ? { upToSeq } : {}),
		});
		await deps.sessions.quietRefreshChats();
		deps.lifecycle.setCurrentChatId(result.chatId);
		deps.sessions.setSelectedChatId(result.chatId);
		deps.navigation.navigateToChat?.(result.chatId);
	}

	async #submitForkOnlyCommand(
		sourceChatId: string,
		previousText: string,
		previousImages: File[],
		restoreComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		try {
			await this.#performForkOnly(sourceChatId);
		} catch (error) {
			if (restoreComposer) {
				deps.composerState.inputText = previousText;
				deps.composerState.images = previousImages;
				deps.composerState.saveDraft(sourceChatId);
			}
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_fork_chat({ detail: errorDetail(error) }),
			);
		}
	}

	handleAbort(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		const previousLoadingStatus = deps.lifecycle.loadingStatus
			? { ...deps.lifecycle.loadingStatus }
			: null;
		const stoppingStatus = { text: m.chat_loading_stopping(), tokens: 0, can_interrupt: false };
		deps.lifecycle.setLoadingStatus(stoppingStatus);
		void stopChat({
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

	handleQueueResume(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void resumeChatQueue(chatId)
			.then((result) => {
				deps.conversationUi.setMessageQueue(chatId, result.queue);
			})
			.catch((error) => {
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_resume_queue({ detail: errorDetail(error) }),
				);
			});
	}

	handleQueuePause(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void pauseChatQueue(chatId)
			.then((result) => {
				deps.conversationUi.setMessageQueue(chatId, result.queue);
			})
			.catch((error) => {
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_pause_queue({ detail: errorDetail(error) }),
				);
			});
	}

	handleDequeue(entryId: string): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void dequeueChatMessage(chatId, entryId)
			.then((result) => {
				deps.conversationUi.setMessageQueue(chatId, result.queue);
			})
			.catch((error) => {
				deps.chatState.appendLocalNotice(
					'error',
					m.chat_notice_failed_remove_queued_message({ detail: errorDetail(error) }),
				);
			});
	}

	// Entry point for the composer model selector. Same-agent selections keep the
	// existing model-switch behavior; cross-agent selections continue the chat
	// under a new agent, seeding a fresh runtime from the canonical transcript.
	handleModelSelectionChange(next: ModelSelectorChange): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		const currentAgentId = deps.sessions.selectedChat?.agentId ?? deps.agentState.agentId;
		if (next.agentId === currentAgentId) {
			this.handleModelChange(next.modelValue);
			return;
		}
		void this.#switchAgent(chatId, next);
	}

	// Continues the active chat under a different agent. Optimistically mirrors
	// the agent, model, and normalized execution modes locally, then reconciles
	// against the server-normalized result, rolling every change back on failure.
	async #switchAgent(chatId: string, next: ModelSelectorChange): Promise<void> {
		const { deps } = this;

		// Draft chats have no live session to continue; the composer gates the
		// selector to active chats, so this is a defensive guard only.
		if (deps.sessions.isDraft(chatId)) {
			deps.chatState.appendLocalNotice(
				'error',
				m.chat_notice_failed_switch_agent({
					agent: deps.modelCatalog.getAgentLabel(next.agentId),
					detail: m.chat_notice_cannot_switch_agent_draft(),
				}),
			);
			return;
		}

		const previous = {
			agentId: deps.sessions.selectedChat?.agentId ?? deps.agentState.agentId,
			model: deps.sessions.selectedChat?.model ?? deps.agentState.model,
			apiProviderId: deps.sessions.selectedChat?.apiProviderId ?? deps.agentState.apiProviderId,
			modelEndpointId:
				deps.sessions.selectedChat?.modelEndpointId ?? deps.agentState.modelEndpointId,
			modelProtocol: deps.sessions.selectedChat?.modelProtocol ?? deps.agentState.modelProtocol,
			permissionMode: deps.sessions.selectedChat?.permissionMode ?? deps.agentState.permissionMode,
			thinkingMode: deps.sessions.selectedChat?.thinkingMode ?? deps.agentState.thinkingMode,
			claudeThinkingMode:
				deps.sessions.selectedChat?.claudeThinkingMode ?? deps.agentState.claudeThinkingMode,
			ampAgentMode: deps.sessions.selectedChat?.ampAgentMode ?? deps.agentState.ampAgentMode,
		};

		const selection = deps.modelCatalog.selectionFor(next.agentId, next.modelValue);

		deps.agentState.setAgentId(next.agentId);
		deps.agentState.setModelSelection({
			model: next.modelValue,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});
		deps.sessions.patchChat(chatId, {
			agentId: next.agentId,
			model: selection.model,
			apiProviderId: selection.apiProviderId,
			modelEndpointId: selection.modelEndpointId,
			modelProtocol: selection.modelProtocol,
		});

		try {
			const result = await updateChatAgentModel({
				chatId,
				agentId: next.agentId,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			});

			// Apply the server-normalized execution modes for the target agent.
			deps.agentState.permissionMode = result.permissionMode;
			deps.agentState.thinkingMode = result.thinkingMode;
			deps.agentState.claudeThinkingMode = result.claudeThinkingMode;
			deps.agentState.ampAgentMode = result.ampAgentMode;
			deps.sessions.patchChat(chatId, {
				permissionMode: result.permissionMode,
				thinkingMode: result.thinkingMode,
				claudeThinkingMode: result.claudeThinkingMode,
				ampAgentMode: result.ampAgentMode,
			});
		} catch (error) {
			this.#rollbackAgentSwitch(chatId, previous, next, error);
			return;
		}

		// Rebuild the transcript so the carried history and the agent-switch
		// boundary render immediately, not only after the next reload. Reload
		// failure is non-fatal: the switch already succeeded server-side.
		try {
			await deps.reloadTranscript?.(chatId);
		} catch {
			// The boundary appears on the next transcript rebuild instead.
		}
	}

	#rollbackAgentSwitch(
		chatId: string,
		previous: {
			agentId: SessionAgentId;
			model: string;
			apiProviderId: string | null;
			modelEndpointId: string | null;
			modelProtocol: ApiProtocol | null;
			permissionMode: PermissionMode;
			thinkingMode: ThinkingMode;
			claudeThinkingMode: ClaudeThinkingMode;
			ampAgentMode: AmpAgentMode;
		},
		next: ModelSelectorChange,
		error: unknown,
	): void {
		const { deps } = this;
		deps.agentState.setAgentId(previous.agentId);
		deps.agentState.setModelSelection({
			model: deps.modelCatalog.selectionValueFor(
				previous.agentId,
				previous.model,
				previous.modelEndpointId,
			),
			apiProviderId: previous.apiProviderId ?? null,
			modelEndpointId: previous.modelEndpointId ?? null,
			modelProtocol: previous.modelProtocol ?? null,
		});
		deps.agentState.permissionMode = previous.permissionMode;
		deps.agentState.thinkingMode = previous.thinkingMode;
		deps.agentState.claudeThinkingMode = previous.claudeThinkingMode;
		deps.agentState.ampAgentMode = previous.ampAgentMode;
		deps.sessions.patchChat(chatId, {
			agentId: previous.agentId,
			model: previous.model,
			apiProviderId: previous.apiProviderId ?? null,
			modelEndpointId: previous.modelEndpointId ?? null,
			modelProtocol: previous.modelProtocol ?? null,
			permissionMode: previous.permissionMode,
			thinkingMode: previous.thinkingMode,
			claudeThinkingMode: previous.claudeThinkingMode,
			ampAgentMode: previous.ampAgentMode,
		});
		deps.chatState.appendLocalNotice(
			'error',
			m.chat_notice_failed_switch_agent({
				agent: deps.modelCatalog.getAgentLabel(next.agentId),
				detail: errorDetail(error),
			}),
		);
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
			deps.agentState.thinkingMode = previous;
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
