// Assembles the EventRouterStores contract from workspace dependencies
// and mounts the WS event router. Isolates protocol-store wiring from
// the UI component so ConversationWorkspace stays composition-focused.

import { goto } from '$app/navigation';
import { createEventRouter, type EventRouterStores } from '$lib/events/router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ComposerState } from '$lib/chat/composer.svelte';
import type { ProviderState } from '$lib/chat/provider-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { PendingPermissionRequest, QueueState, PermissionMode, PendingViewChat } from '$lib/types/chat';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export interface ConversationRouterDeps {
	ws: WsConnection;
	drainHandle: DrainHandle;
	sessions: {
		selectedChat: ChatSessionRecord | null;
		selectedChatId: string | null;
		byId: Record<string, ChatSessionRecord>;
		order: string[];
		hasChat: (chatId: string) => boolean;
		patchPreview: (chatId: string, content: string) => void;
		patchChat: (chatId: string, patch: Record<string, unknown>) => void;
		patchLastReadAt: (chatId: string, lastReadAt: string) => void;
		removeChat: (chatId: string) => void;
		setSelectedChatId: (id: string | null) => void;
		setChatProcessing: (chatId: string, isProcessing: boolean) => void;
		reconcileProcessing: (activeChatIds: Set<string>) => void;
	};
	chatState: ChatState;
	composerState: ComposerState;
	providerState: ProviderState;
	lifecycle: ChatLifecycleStore;
	startupCoordinator: StartupCoordinator;
	appShell: { quietRefreshChats: () => void };
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	// Mutable binding references for per-chat reactive state.
	getPendingPermissionRequests: () => PendingPermissionRequest[];
	setPendingPermissionRequests: (updater: PendingPermissionRequest[] | ((prev: PendingPermissionRequest[]) => PendingPermissionRequest[])) => void;
	getPendingViewChat: () => PendingViewChat | null;
	setPendingViewChat: (v: PendingViewChat | null) => void;
	setMessageQueue: (chatId: string, q: QueueState | null) => void;
	getPreviousPermissionMode: () => PermissionMode | null;
	setPreviousPermissionMode: (mode: PermissionMode | null) => void;
}

// Builds a ChatEntry-compatible object from the session store for the
// event router, which expects the selectedChat() accessor.
function selectedChatForRouter(deps: ConversationRouterDeps) {
	const chat = deps.sessions.selectedChat;
	if (!chat) return null;
	return {
		id: chat.id,
		projectPath: chat.projectPath,
		provider: chat.provider,
		model: chat.model,
		title: chat.title,
	};
}

// Assembles the EventRouterStores contract from workspace dependencies.
export function buildRouterStores(deps: ConversationRouterDeps): EventRouterStores {
	return {
		provider: () => deps.providerState.provider,
		selectedChat: () => selectedChatForRouter(deps),
		currentChatId: () => deps.lifecycle.currentChatId,
		setCurrentChatId: (id) => deps.lifecycle.setCurrentChatId(id),
		chatMessages: () => deps.chatState.chatMessages,
		setChatMessages: (updater) => {
			if (typeof updater === 'function') {
				deps.chatState.chatMessages = updater(deps.chatState.chatMessages);
			} else {
				deps.chatState.chatMessages = updater;
			}
		},
		loadMessages: (chatId) => deps.chatState.loadMessages(chatId, deps.ws),
		setIsLoading: (v) => deps.lifecycle.setIsLoading(v),
		setCanAbort: (v) => deps.lifecycle.setCanAbort(v),
		setLoadingStatus: (s) => deps.lifecycle.setLoadingStatus(s),
		pushLoadingStatus: (e) => deps.lifecycle.pushLoadingStatus(e),
		popLoadingStatus: (id) => deps.lifecycle.popLoadingStatus(id),
		setIsSystemChatChange: (v) => deps.lifecycle.setIsSystemChatChange(v),
		pendingPermissionRequests: deps.getPendingPermissionRequests,
		setPendingPermissionRequests: deps.setPendingPermissionRequests,
		pendingViewChat: deps.getPendingViewChat,
		setPendingViewChat: deps.setPendingViewChat,
		setMessageQueue: deps.setMessageQueue,
		permissionMode: () => deps.providerState.permissionMode,
		previousPermissionMode: deps.getPreviousPermissionMode,
		setPermissionMode: (mode) => { deps.providerState.permissionMode = mode; },
		setPreviousPermissionMode: deps.setPreviousPermissionMode,
		reconcileProcessing: (activeChatIds) => deps.sessions.reconcileProcessing(activeChatIds),
		setChatProcessing: (chatId, isProcessing) => deps.sessions.setChatProcessing(chatId, isProcessing),
		startupCoordinator: deps.startupCoordinator,
		onLocalStartupConfirmed: (chatId) => {
			deps.sessions.setChatProcessing(chatId, true);
			deps.lifecycle.setCurrentChatId(chatId);
			deps.sessions.setSelectedChatId(chatId);
			goto(`/chat/${chatId}`);
			deps.appShell.quietRefreshChats();
		},
		onExternalChatCreated: (chatId) => {
			if (!deps.sessions.hasChat(chatId)) {
				deps.appShell.quietRefreshChats();
			}
		},
		patchChatPreview: (chatId, content, _timestamp) => {
			deps.sessions.patchPreview(chatId, content);
		},
		refreshChats: () => deps.appShell.quietRefreshChats(),
		hasChat: (chatId) => deps.sessions.hasChat(chatId),
		navigateToChat: (chatId) => {
			goto(`/chat/${chatId}`);
			deps.appShell.quietRefreshChats();
		},
		removeChat: (chatId) => deps.sessions.removeChat(chatId),
		patchChatTitle: (chatId, title) => deps.sessions.patchChat(chatId, { title }),
		navigateAwayFromChat: (chatId) => {
			if (deps.sessions.selectedChatId !== chatId) return;
			const idx = deps.sessions.order.indexOf(chatId);
			const neighborId = deps.sessions.order[idx - 1] ?? deps.sessions.order[idx + 1] ?? null;
			if (neighborId) {
				deps.sessions.setSelectedChatId(neighborId);
				goto(`/chat/${neighborId}`);
			} else {
				deps.sessions.setSelectedChatId(null);
				goto('/');
			}
		},
		patchLastReadAt: (chatId, lastReadAt) => deps.sessions.patchLastReadAt(chatId, lastReadAt),
		enqueueReadReceipt: (chatId, readAt) => {
			deps.readReceiptOutbox.enqueue(chatId, readAt);
			deps.sessions.patchLastReadAt(chatId, readAt);
		},
		removeChatSnapshot: (chatId) => deps.chatState.snapshotCache.remove(chatId),
		markChatSnapshotValidated: (chatId) => deps.chatState.snapshotCache.markValidated(chatId),
	};
}

// Mounts the event router by assembling the store contract and invoking
// createEventRouter. Must be called during component initialization
// (inside a Svelte 5 $effect scope).
export function mountConversationRouter(deps: ConversationRouterDeps): void {
	const stores = buildRouterStores(deps);
	createEventRouter(deps.ws, deps.drainHandle, stores);
}
