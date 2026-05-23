// Chat session controller. Owns chat lifecycle transitions, message
// submission, permission decisions, queue control, and mode persistence.
// No direct DOM access -- all viewport operations are delegated via
// callback functions supplied through the deps interface.

import {
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
	updateChatModel,
	updateExecutionSettings,
} from '$lib/api/chats.js';
import { AssistantMessage, ErrorMessage, type ChatImage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import { createClientChatId } from '$lib/chat/client-id';
import { createClientCommandId } from '$lib/chat/client-command-id';
import { parseForkCommand } from '$lib/chat/fork-command';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ComposerState } from '$lib/chat/composer.svelte';
import type { AgentState } from '$lib/chat/agent-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { AmpAgentMode, PendingPermissionRequest, PermissionMode, QueueState, ThinkingMode } from '$lib/types/chat';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { AppTab, SessionAgentId } from '$lib/types/app';
import type { ApiProtocol } from '$shared/api-providers';

export interface SessionControllerDeps {
	sessions: {
		selectedChatId: string | null;
		selectedChat: ChatSessionRecord | null;
		byId: Record<string, ChatSessionRecord>;
		startupByChatId: Record<string, { agentId: string; model: string; apiProviderId?: string | null; modelEndpointId?: string | null; modelProtocol?: ApiProtocol | null; tags?: string[]; permissionMode: PermissionMode; thinkingMode: ThinkingMode; claudeThinkingMode?: string; ampAgentMode: AmpAgentMode; firstMessage: string; initialImages?: File[] }>;
		isDraft: (chatId: string) => boolean;
		patchDraftStartup: (chatId: string, patch: Record<string, unknown>) => void;
		patchChat: (chatId: string, patch: Record<string, unknown>) => void;
		patchLastReadAt: (chatId: string, lastReadAt: string) => void;
		promoteDraft: (chatId: string) => void;
		setChatProcessing: (chatId: string, isProcessing: boolean) => void;
		setSelectedChatId: (id: string | null) => void;
	};
	chatState: ChatState;
	composerState: ComposerState;
	agentState: AgentState;
	lifecycle: ChatLifecycleStore;
	startupCoordinator: StartupCoordinator;
	modelCatalog: {
		isLocalModel: (agentId: SessionAgentId, model: string, modelEndpointId?: string | null) => boolean;
		selectionFor: (agentId: SessionAgentId, model: string, modelEndpointId?: string | null) => {
			model: string;
			apiProviderId: string | null;
			modelEndpointId: string | null;
			modelProtocol: ApiProtocol | null;
		};
		selectionValueFor: (agentId: SessionAgentId, model: string, modelEndpointId?: string | null) => string;
	};
	appShell: {
		quietRefreshChats: () => Promise<void> | void;
		openNewChatDialog: (opts: { prefill: string }) => void;
	};
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	navigation: { setActiveTab: (tab: AppTab) => void; navigateToChat?: (chatId: string) => void };
	// Mutable binding accessors for per-chat UI state.
	getPendingPermissionRequests: () => PendingPermissionRequest[];
	setPendingPermissionRequests: (v: PendingPermissionRequest[]) => void;
	getPreviousPermissionMode: () => PermissionMode | null;
	setPreviousPermissionMode: (v: PermissionMode | null) => void;
	setNeedsServerLoad: (v: boolean) => void;
	setIsViewportPinnedToBottom: (v: boolean) => void;
	setMessageQueue: (chatId: string, queue: QueueState | null) => void;
	scrollToBottom: () => void;
}

async function fileToChatImage(file: File): Promise<ChatImage> {
	const buffer = await file.arrayBuffer();
	const base64 = btoa(
		new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
	);
	return { data: `data:${file.type};base64,${base64}`, name: file.name };
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

	#markPendingUserInputDelivery(clientRequestId: string, deliveryStatus: 'accepted' | 'failed'): void {
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
		deps.setNeedsServerLoad(false);
		deps.navigation.setActiveTab('chat');

		if (!chatId) {
			deps.chatState.clearMessages();
			deps.composerState.inputText = '';
			deps.lifecycle.clearLoading();
			deps.lifecycle.setCurrentChatId(null);
			deps.setPendingPermissionRequests([]);
			deps.setIsViewportPinnedToBottom(true);
			return;
		}

		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) return;

		deps.chatState.resetForNewChat();

		// Restore cached messages immediately so the user sees content
		// while the server round-trip completes.
		const restored = deps.chatState.restoreMessages(chatId);
		if (restored) {
			requestAnimationFrame(() => deps.scrollToBottom());
		}

		deps.composerState.inputText = '';
		deps.composerState.clearImages();
		deps.lifecycle.clearLoading();
		deps.setPendingPermissionRequests([]);
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
				deps.agentState.setAgentId(startup.agentId as Parameters<typeof deps.agentState.setAgentId>[0]);
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
			getChatQueue(chatId).then((result) => {
				if (deps.sessions.selectedChatId === chatId) {
					deps.setMessageQueue(chatId, result.queue);
				}
			}).catch(() => {
				// Queue state will refresh through later broadcasts or reconnect reconciliation.
		});

		if (selected.lastActivityAt && (!selected.lastReadAt || selected.lastReadAt < selected.lastActivityAt)) {
			deps.readReceiptOutbox.enqueue(chatId, selected.lastActivityAt);
			deps.sessions.patchLastReadAt(chatId, selected.lastActivityAt);
		}

		deps.agentState.permissionMode = selected.permissionMode ?? 'default';
		deps.agentState.thinkingMode = selected.thinkingMode ?? 'none';
		deps.agentState.ampAgentMode = selected.ampAgentMode ?? 'smart';

		this.loadChat(chatId);
	}

	async loadChat(chatId: string): Promise<void> {
		const { deps } = this;

		// Restore from cache if no messages are loaded yet (e.g., WS reconnect path).
		// The primary restore happens earlier in handleChatSwitch.
		if (deps.chatState.chatMessages.length === 0) {
			deps.chatState.restoreMessages(chatId);
		}

		if (deps.chatState.chatMessages.length > 0) {
			requestAnimationFrame(() => deps.scrollToBottom());
		}

		try {
			const messages = await deps.chatState.loadMessages(chatId);
			if (deps.sessions.selectedChatId !== chatId) return;

			deps.chatState.setMessages(messages);
			deps.chatState.snapshotCache.markValidated(chatId);
			deps.setNeedsServerLoad(false);
			requestAnimationFrame(() => deps.scrollToBottom());

			const record = deps.sessions.byId[chatId];
			if (record?.lastActivityAt && (!record.lastReadAt || record.lastReadAt < record.lastActivityAt)) {
				deps.readReceiptOutbox.enqueue(chatId, record.lastActivityAt);
				deps.sessions.patchLastReadAt(chatId, record.lastActivityAt);
			}
		} catch {
			if (deps.sessions.selectedChatId !== chatId) return;
			deps.setNeedsServerLoad(true);
		}
	}

	// Submits a message for a specific chat. Accepts explicit chatId to
	// prevent selection-dependent races during draft startup.
	async submitForChat(
		chatId: string,
		messageOverride?: string,
		imageOverride?: File[],
		options: { allowForkCommand?: boolean } = {},
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

		if (options.allowForkCommand !== false) {
			const forkCommand = parseForkCommand(text);
			if (forkCommand) {
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

			if (selected.status === 'running' && selected.isProcessing && submissionImages.length > 0) {
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(new Date().toISOString(), 'Messages with images cannot be queued while a turn is already running.'),
				];
				return;
			}

			let imagePayload: ChatImage[] = [];
			if (submissionImages.length > 0) {
				try {
				imagePayload = await Promise.all(submissionImages.map(fileToChatImage));
			} catch (error) {
				console.error('[SessionController] Failed to prepare image payload:', error);
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(
						new Date().toISOString(),
						`Failed to prepare images: ${error instanceof Error ? error.message : String(error)}`,
					),
				];
				return;
			}
			}

			if (selected.status === 'running' && selected.isProcessing) {
				try {
					const result = await enqueueChatMessage({
						clientRequestId: createClientCommandId(),
						chatId,
						content: text,
					});
					deps.setMessageQueue(chatId, result.queue);
					deps.composerState.clearAfterSubmit(chatId);
				} catch (err) {
					deps.chatState.chatMessages = [
						...deps.chatState.chatMessages,
						new ErrorMessage(
							new Date().toISOString(),
							`Failed to queue message: ${err instanceof Error ? err.message : String(err)}`,
						),
					];
				}
				return;
			}

			if (deps.lifecycle.isLoading && selected.status === 'draft') return;

			const clientRequestId = createClientCommandId();
			const clientMessageId = createClientCommandId();
			deps.chatState.upsertPendingUserInput(
				pendingUserInput(chatId, text, imagePayload, clientRequestId, clientMessageId),
			);
			deps.chatState.isUserScrolledUp = false;
			if (restoreComposerOnFailure) {
				deps.composerState.clearAfterSubmit(chatId);
			}
			deps.composerState.isSubmitting = true;

			if (isDraft) {
				deps.startupCoordinator.beginLocalStartup(chatId);
				const agentId = startup?.agentId ?? selected.agentId;
				const model = startup?.model ?? selected.model ?? deps.agentState.model;
				const apiProviderId = startup?.apiProviderId ?? selected.apiProviderId ?? deps.agentState.apiProviderId;
				const modelEndpointId = startup?.modelEndpointId ?? selected.modelEndpointId ?? deps.agentState.modelEndpointId;
				const modelProtocol = startup?.modelProtocol ?? selected.modelProtocol ?? deps.agentState.modelProtocol;
				const permissionMode = startup?.permissionMode ?? deps.agentState.permissionMode;
				const thinkingMode = startup?.thinkingMode ?? deps.agentState.thinkingMode;
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
						claudeThinkingMode: 'auto',
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
					deps.lifecycle.activateLoading();
					deps.lifecycle.setCanAbort(true);
					deps.lifecycle.setLoadingStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
					deps.lifecycle.setCurrentChatId(chatId);
					deps.sessions.setChatProcessing(chatId, true);
					deps.sessions.promoteDraft(chatId);
					deps.appShell.quietRefreshChats();
				} catch (err) {
					console.error('[SessionController] Failed to start chat:', err);
					this.#markPendingUserInputDelivery(clientRequestId, 'failed');
					deps.startupCoordinator.completeStartup(chatId);
					deps.lifecycle.clearLoading();
					deps.sessions.setChatProcessing(chatId, false);
					if (restoreComposerOnFailure) {
						deps.composerState.inputText = previousText;
						deps.composerState.images = previousImages;
						deps.composerState.saveDraft(chatId);
					}
					deps.chatState.chatMessages = [
						...deps.chatState.chatMessages,
						new ErrorMessage(
							new Date().toISOString(),
							`Failed to start chat: ${err instanceof Error ? err.message : String(err)}`,
						),
					];
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
						claudeThinkingMode: 'auto',
						ampAgentMode: deps.agentState.ampAgentMode,
						model: selection.model,
						apiProviderId: selection.apiProviderId,
						modelEndpointId: selection.modelEndpointId,
						modelProtocol: selection.modelProtocol,
					});
					this.#markPendingUserInputDelivery(clientRequestId, 'accepted');
					deps.lifecycle.activateLoading();
					deps.lifecycle.setCanAbort(true);
					deps.lifecycle.setLoadingStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
					deps.lifecycle.setCurrentChatId(chatId);
					deps.sessions.setChatProcessing(chatId, true);
				} catch (err) {
					this.#markPendingUserInputDelivery(clientRequestId, 'failed');
					deps.lifecycle.clearLoading();
					deps.sessions.setChatProcessing(chatId, false);
					if (restoreComposerOnFailure) {
						deps.composerState.inputText = previousText;
						deps.composerState.images = previousImages;
						deps.composerState.saveDraft(chatId);
					}
					deps.chatState.chatMessages = [
						...deps.chatState.chatMessages,
						new ErrorMessage(
							new Date().toISOString(),
							`Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
						),
					];
				} finally {
					deps.composerState.isSubmitting = false;
				}
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
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(new Date().toISOString(), 'Cannot fork a draft chat. Select an existing chat first.'),
			];
			return;
		}

		const previousText = deps.composerState.inputText;
		const previousImages = [...deps.composerState.images];
		deps.chatState.chatMessages = [
			...deps.chatState.chatMessages,
			new AssistantMessage(new Date().toISOString(), 'Forking chat..'),
		];
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
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(
						new Date().toISOString(),
						`Failed to prepare images: ${error instanceof Error ? error.message : String(error)}`,
					),
				];
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
				await deps.appShell.quietRefreshChats();
				deps.lifecycle.setCurrentChatId(forkChatId);
				deps.lifecycle.activateLoading();
				deps.lifecycle.setCanAbort(true);
				deps.lifecycle.setLoadingStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
				deps.sessions.setSelectedChatId(forkChatId);
				deps.sessions.setChatProcessing(forkChatId, true);
				deps.navigation.navigateToChat?.(forkChatId);
			} catch (error) {
				if (clearComposer) {
					deps.composerState.inputText = previousText;
					deps.composerState.images = previousImages;
				deps.composerState.saveDraft(sourceChatId);
				}
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(
						new Date().toISOString(),
						`Failed to fork chat: ${error instanceof Error ? error.message : String(error)}`,
					),
				];
			}
		}

	async #submitForkOnlyCommand(
		sourceChatId: string,
		previousText: string,
		previousImages: File[],
		restoreComposer: boolean,
	): Promise<void> {
		const { deps } = this;
		const forkChatId = createClientChatId();

		try {
			const result = await forkChat({ sourceChatId, chatId: forkChatId });
			await deps.appShell.quietRefreshChats();
			deps.lifecycle.setCurrentChatId(result.chatId);
			deps.sessions.setSelectedChatId(result.chatId);
			deps.navigation.navigateToChat?.(result.chatId);
		} catch (error) {
			if (restoreComposer) {
				deps.composerState.inputText = previousText;
				deps.composerState.images = previousImages;
				deps.composerState.saveDraft(sourceChatId);
			}
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to fork chat: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		}
	}

	handleAbort(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		deps.lifecycle.setLoadingStatus({ text: 'Stopping', tokens: 0, can_interrupt: false });
		void stopChat({
			clientRequestId: createClientCommandId(),
			chatId,
			agentId: deps.agentState.agentId,
		}).then(() => {
			deps.lifecycle.clearLoading();
		}).catch((error) => {
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to stop chat: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		});
	}

	handlePermissionDecision(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void sendPermissionDecision({
			clientRequestId: createClientCommandId(),
			chatId,
			permissionRequestId,
			allow: decision.allow,
			alwaysAllow: Boolean(decision.alwaysAllow),
		}).then(() => {
			deps.setPendingPermissionRequests(
				deps.getPendingPermissionRequests().filter((r) => r.permissionRequestId !== permissionRequestId),
			);
		}).catch((error) => {
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to send permission decision: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		});
	}

	handleExitPlanMode(permissionRequestId: string, choice: string, plan: string): void {
		const { deps } = this;
		deps.setPendingPermissionRequests(
			deps.getPendingPermissionRequests().filter((r) => r.permissionRequestId !== permissionRequestId),
		);

		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		const path = deps.sessions.selectedChat?.projectPath;

		const buildApprovalMessage = () =>
			`User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n${plan}`;

		const resumeWithApproval = (mode: PermissionMode) => {
			deps.setPreviousPermissionMode(null);
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
				claudeThinkingMode: 'auto',
				ampAgentMode: deps.agentState.ampAgentMode,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			}).then(() => {
				deps.lifecycle.activateLoading();
				deps.lifecycle.setCanAbort(true);
				deps.lifecycle.setLoadingStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
				deps.sessions.setChatProcessing(chatId, true);
			}).catch((error) => {
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(
						new Date().toISOString(),
						`Failed to resume plan: ${error instanceof Error ? error.message : String(error)}`,
					),
				];
			});
		};

		switch (choice) {
			case 'bypass-new': {
				const restoreMode = deps.getPreviousPermissionMode() || 'default';
				deps.setPreviousPermissionMode(null);
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
							deps.chatState.chatMessages = [
								...deps.chatState.chatMessages,
								new ErrorMessage(
									new Date().toISOString(),
									`Failed to deny permission: ${error instanceof Error ? error.message : String(error)}`,
								),
							];
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
		void resumeChatQueue(chatId).then((result) => {
			deps.setMessageQueue(chatId, result.queue);
		}).catch((error) => {
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to resume queue: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		});
	}

	handleQueuePause(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void pauseChatQueue(chatId).then((result) => {
			deps.setMessageQueue(chatId, result.queue);
		}).catch((error) => {
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to pause queue: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		});
	}

	handleDequeue(entryId: string): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		void dequeueChatMessage(chatId, entryId).then((result) => {
			deps.setMessageQueue(chatId, result.queue);
		}).catch((error) => {
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to remove queued message: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		});
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
		const currentEndpointId = deps.sessions.selectedChat?.modelEndpointId ?? deps.agentState.modelEndpointId;
		const wasLocal = deps.modelCatalog.isLocalModel(agentId, currentModel, currentEndpointId);
		const isLocal = deps.modelCatalog.isLocalModel(agentId, model, selection.modelEndpointId);
		if (wasLocal !== isLocal) {
			const target = isLocal ? 'local' : 'cloud';
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Cannot switch to a ${target} model mid-session. Start a new chat to use ${selection.model}.`,
				),
			];
			return;
		}

		const previousModel = deps.sessions.selectedChat?.model ?? deps.agentState.model;
		const previousApiProviderId = deps.sessions.selectedChat?.apiProviderId ?? deps.agentState.apiProviderId;
		const previousEndpointId = deps.sessions.selectedChat?.modelEndpointId ?? deps.agentState.modelEndpointId;
		const previousProtocol = deps.sessions.selectedChat?.modelProtocol ?? deps.agentState.modelProtocol;
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
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to update model: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
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
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to update permission mode: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
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
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to update thinking mode: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
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
			deps.chatState.chatMessages = [
				...deps.chatState.chatMessages,
				new ErrorMessage(
					new Date().toISOString(),
					`Failed to update agent mode: ${error instanceof Error ? error.message : String(error)}`,
				),
			];
		});
	}
}
