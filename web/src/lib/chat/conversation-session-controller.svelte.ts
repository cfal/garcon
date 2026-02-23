// Chat session controller. Owns chat lifecycle transitions, message
// submission, permission decisions, queue control, and mode persistence.
// No direct DOM access -- all viewport operations are delegated via
// callback functions supplied through the deps interface.

import { startChat } from '$lib/api/chats.js';
import { UserMessage, ErrorMessage, type ChatImage } from '$shared/chat-types';
import {
	AgentStopRequest,
	PermissionDecisionRequest,
	QueueResumeRequest,
	QueuePauseRequest,
	QueueDropRequest,
	ModelSetRequest,
	PermissionModeSetRequest,
	ThinkingModeSetRequest,
	QueueEnqueueRequest,
	AgentRunRequest,
	QueueQueryRequest,
} from '$shared/ws-requests';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ComposerState } from '$lib/chat/composer.svelte';
import type { ProviderState } from '$lib/chat/provider-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { PendingPermissionRequest, PermissionMode } from '$lib/types/chat';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { AppTab } from '$lib/types/app';

export interface SessionControllerDeps {
	sessions: {
		selectedChatId: string | null;
		selectedChat: ChatSessionRecord | null;
		byId: Record<string, ChatSessionRecord>;
		startupByChatId: Record<string, { provider: string; model: string; permissionMode: PermissionMode; thinkingMode: string; firstMessage: string; initialImages?: File[] }>;
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
	providerState: ProviderState;
	lifecycle: ChatLifecycleStore;
	startupCoordinator: StartupCoordinator;
	ws: WsConnection;
	appShell: { quietRefreshChats: () => void; openNewChatDialog: (opts: { prefill: string }) => void };
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	navigation: { setActiveTab: (tab: AppTab) => void };
	// Mutable binding accessors for per-chat UI state.
	getPendingPermissionRequests: () => PendingPermissionRequest[];
	setPendingPermissionRequests: (v: PendingPermissionRequest[]) => void;
	getPreviousPermissionMode: () => PermissionMode | null;
	setPreviousPermissionMode: (v: PermissionMode | null) => void;
	setNeedsServerLoad: (v: boolean) => void;
	setIsViewportPinnedToBottom: (v: boolean) => void;
	scrollToBottom: () => void;
}

async function fileToChatImage(file: File): Promise<ChatImage> {
	const buffer = await file.arrayBuffer();
	const base64 = btoa(
		new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
	);
	return { data: `data:${file.type};base64,${base64}`, name: file.name };
}

export class ConversationSessionController {
	#lastChatId: string | null = null;

	constructor(private deps: SessionControllerDeps) {}

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
		deps.composerState.inputText = '';
		deps.composerState.clearImages();
		deps.lifecycle.clearLoading();
		deps.setPendingPermissionRequests([]);
		deps.setIsViewportPinnedToBottom(true);

		if (selected.provider) {
			deps.providerState.setProvider(selected.provider);
		}
		if (selected.model) {
			deps.providerState.model = selected.model;
		}

		if (selected.status === 'draft') {
			deps.lifecycle.setCurrentChatId(null);
			const startup = deps.sessions.startupByChatId[chatId];
			if (startup) {
				deps.providerState.setProvider(startup.provider as Parameters<typeof deps.providerState.setProvider>[0]);
				deps.providerState.model = startup.model;
				if (startup.permissionMode) {
					deps.providerState.permissionMode = startup.permissionMode;
				}
				if (startup.thinkingMode) {
					deps.providerState.thinkingMode = startup.thinkingMode;
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
		deps.ws.sendMessage(new QueueQueryRequest(chatId));

		deps.providerState.permissionMode = selected.permissionMode ?? 'default';
		deps.providerState.thinkingMode = selected.thinkingMode ?? 'none';

		this.loadChat(chatId);
	}

	async loadChat(chatId: string): Promise<void> {
		const { deps } = this;
		deps.chatState.restoreMessages(chatId);
		if (deps.chatState.chatMessages.length > 0) {
			requestAnimationFrame(() => deps.scrollToBottom());
		}

		try {
			const messages = await deps.chatState.loadMessages(chatId, deps.ws);
			if (deps.sessions.selectedChatId !== chatId) return;

			deps.chatState.setMessages(messages);
			deps.setNeedsServerLoad(false);
			requestAnimationFrame(() => deps.scrollToBottom());

			const record = deps.sessions.byId[chatId];
			if (record?.lastActivityAt) {
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
	async submitForChat(chatId: string, messageOverride?: string, imageOverride?: File[]): Promise<void> {
		const { deps } = this;
		const selected = deps.sessions.byId[chatId];
		if (!selected?.projectPath) return;
		const isDraft = selected.status === 'draft';
		const startup = deps.sessions.startupByChatId[chatId];

		const text = messageOverride ?? deps.composerState.inputText.trim();
		const submissionImages = imageOverride ?? deps.composerState.images;
		if (!text && submissionImages.length === 0) return;

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
			const sent = deps.ws.sendMessage(
				new QueueEnqueueRequest(chatId, text, deps.providerState.provider, selected.projectPath, selected.projectPath),
			);
			if (sent) {
				deps.composerState.clearAfterSubmit(chatId);
			} else {
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(new Date().toISOString(), 'Failed to queue message: Not connected to server'),
				];
			}
			return;
		}

		if (deps.lifecycle.isLoading && selected.status === 'draft') return;

		deps.chatState.chatMessages = [
			...deps.chatState.chatMessages,
			new UserMessage(new Date().toISOString(), text, imagePayload),
		];
		deps.chatState.isUserScrolledUp = false;

		deps.lifecycle.activateLoading();
		deps.lifecycle.setCanAbort(true);
		deps.lifecycle.setLoadingStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
		deps.lifecycle.setCurrentChatId(chatId);
		deps.sessions.setChatProcessing(chatId, true);

		if (isDraft) {
			deps.startupCoordinator.beginLocalStartup(chatId);
			const provider = startup?.provider ?? selected.provider;
			const model = startup?.model ?? selected.model ?? deps.providerState.model;
			const permissionMode = startup?.permissionMode ?? deps.providerState.permissionMode;
			const thinkingMode = startup?.thinkingMode ?? deps.providerState.thinkingMode;

			deps.composerState.clearAfterSubmit(chatId);
			try {
				await startChat({
					chatId,
					provider,
					projectPath: selected.projectPath,
					model,
					command: text,
					options: {
						cwd: selected.projectPath,
						projectPath: selected.projectPath,
						sessionId: chatId,
						permissionMode,
						thinkingMode,
						images: imagePayload,
					},
				});
				deps.sessions.promoteDraft(chatId);
				deps.appShell.quietRefreshChats();
			} catch (err) {
				console.error('[SessionController] Failed to start chat:', err);
				deps.startupCoordinator.completeStartup(chatId);
				deps.lifecycle.clearLoading();
				deps.sessions.setChatProcessing(chatId, false);
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(
						new Date().toISOString(),
						`Failed to start chat: ${err instanceof Error ? err.message : String(err)}`,
					),
				];
			}
		} else {
			const sent = await deps.composerState.submitMessage(deps.ws, chatId, {
				provider: selected.provider,
				model: selected.model ?? deps.providerState.model,
				permissionMode: deps.providerState.permissionMode,
				projectPath: selected.projectPath,
				isNewChat: false,
				thinkingMode: deps.providerState.thinkingMode,
			});
			if (!sent) {
				deps.lifecycle.clearLoading();
				deps.sessions.setChatProcessing(chatId, false);
				deps.chatState.chatMessages = [
					...deps.chatState.chatMessages,
					new ErrorMessage(new Date().toISOString(), 'Failed to send message: Not connected to server'),
				];
			}
		}
	}

	handleAbort(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		if (!chatId) return;
		deps.ws.sendMessage(new AgentStopRequest(chatId, deps.providerState.provider));
		deps.lifecycle.clearLoading();
	}

	handlePermissionDecision(permissionRequestId: string, decision: { allow: boolean; alwaysAllow?: boolean }): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		deps.ws.sendMessage(
			new PermissionDecisionRequest(chatId, permissionRequestId, decision.allow, Boolean(decision.alwaysAllow)),
		);
		deps.setPendingPermissionRequests(
			deps.getPendingPermissionRequests().filter((r) => r.permissionRequestId !== permissionRequestId),
		);
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

		const resumeWithApproval = (mode: string) => {
			deps.setPreviousPermissionMode(null);
			deps.providerState.permissionMode = mode as PermissionMode;
			if (!chatId || !path) return;

			deps.lifecycle.activateLoading();
			deps.lifecycle.setCanAbort(true);
			deps.lifecycle.setLoadingStatus({ text: 'Processing', tokens: 0, can_interrupt: true });

			deps.ws.sendMessage(
				new AgentRunRequest(chatId, deps.providerState.provider, buildApprovalMessage(), false, {
					cwd: path,
					projectPath: path,
					sessionId: chatId,
					resume: true,
					model: deps.providerState.model ?? undefined,
					permissionMode: mode,
				}),
			);
		};

		switch (choice) {
			case 'bypass-new': {
				const restoreMode = deps.getPreviousPermissionMode() || 'default';
				deps.setPreviousPermissionMode(null);
				deps.providerState.permissionMode = restoreMode as PermissionMode;

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
					deps.ws.sendMessage(new PermissionDecisionRequest(chatId, permissionRequestId, false, false));
				}
				break;
			}
		}
	}

	handleQueueResume(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		deps.ws.sendMessage(new QueueResumeRequest(chatId));
	}

	handleQueuePause(): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		deps.ws.sendMessage(new QueuePauseRequest(chatId));
	}

	handleDequeue(entryId: string): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId || deps.lifecycle.currentChatId;
		deps.ws.sendMessage(new QueueDropRequest(chatId, entryId));
	}

	handleModelChange(model: string): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		if (deps.sessions.isDraft(chatId)) {
			deps.sessions.patchDraftStartup(chatId, { model });
			deps.sessions.patchChat(chatId, { model });
			return;
		}
		deps.ws.sendMessage(new ModelSetRequest(chatId, model));
		deps.sessions.patchChat(chatId, { model });
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
		deps.ws.sendMessage(new PermissionModeSetRequest(chatId, mode));
		deps.sessions.patchChat(chatId, { permissionMode: mode });
	}

	handleThinkingModeChange(mode: string): void {
		const { deps } = this;
		const chatId = deps.sessions.selectedChatId;
		if (!chatId) return;
		if (deps.sessions.isDraft(chatId)) {
			deps.sessions.patchDraftStartup(chatId, { thinkingMode: mode });
			deps.sessions.patchChat(chatId, { thinkingMode: mode });
			return;
		}
		deps.ws.sendMessage(new ThinkingModeSetRequest(chatId, mode));
		deps.sessions.patchChat(chatId, { thinkingMode: mode });
	}
}
