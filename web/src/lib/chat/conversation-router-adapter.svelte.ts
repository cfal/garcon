// Assembles the EventRouterStores contract from workspace dependencies
// and mounts the WS event router. Isolates protocol-store wiring from
// the UI component so ConversationWorkspace stays composition-focused.

import { goto } from '$app/navigation';
import { createEventRouter, type EventRouterStores } from '$lib/events/router.svelte';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ChatState } from '$lib/chat/state.svelte';
import type { AgentState } from '$lib/chat/agent-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
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
		patchChat: (chatId: string, patch: Partial<ChatSessionRecord>) => void;
		patchLastReadAt: (chatId: string, lastReadAt: string) => void;
		removeChat: (chatId: string) => void;
		setSelectedChatId: (id: string | null) => void;
		setChatProcessing: (chatId: string, isProcessing: boolean) => void;
		reconcileProcessing: (activeChatIds: Set<string>) => void;
		quietRefreshChats: () => Promise<void> | void;
	};
	chatState: ChatState;
	agentState: AgentState;
	lifecycle: ChatLifecycleStore;
	conversationUi: ConversationUiStore;
	startupCoordinator: StartupCoordinator;
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
}

// Assembles the EventRouterStores contract from workspace dependencies.
export function buildRouterStores(deps: ConversationRouterDeps): EventRouterStores {
	return {
		agentSettings: {
			permissionMode: () => deps.agentState.permissionMode,
			setPermissionMode: (mode) => {
				deps.agentState.permissionMode = mode;
			},
		},
		chatState: {
			setChatMessages: (updater) => {
				const nextMessages =
					typeof updater === 'function' ? updater(deps.chatState.chatMessages) : updater;
				deps.chatState.setMessages(nextMessages);
			},
			appendChatMessagesByIdentity: (messages) =>
				deps.chatState.appendMessagesByIdentity(messages),
			upsertPendingUserInput: (input) => deps.chatState.upsertPendingUserInput(input),
			clearPendingUserInput: (clientRequestId) =>
				deps.chatState.clearPendingUserInput(clientRequestId),
			updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) =>
				deps.chatState.updatePendingUserInputDeliveryStatus(clientRequestId, deliveryStatus),
			loadMessages: (chatId, options) => deps.chatState.loadMessages(chatId, options),
			removeChatSnapshot: (chatId) => deps.chatState.snapshotCache.remove(chatId),
			markChatSnapshotValidated: (chatId) => deps.chatState.snapshotCache.markValidated(chatId),
		},
		lifecycle: {
			currentChatId: () => deps.lifecycle.currentChatId,
			setCurrentChatId: (id) => deps.lifecycle.setCurrentChatId(id),
			setIsLoading: (v) => deps.lifecycle.setIsLoading(v),
			setCanAbort: (v) => deps.lifecycle.setCanAbort(v),
			setLoadingStatus: (s) => deps.lifecycle.setLoadingStatus(s),
			pushLoadingStatus: (e) => deps.lifecycle.pushLoadingStatus(e),
			popLoadingStatus: (id) => deps.lifecycle.popLoadingStatus(id),
			setIsSystemChatChange: (v) => deps.lifecycle.setIsSystemChatChange(v),
		},
		conversationUi: deps.conversationUi,
		sessions: {
			selectedChat: () => deps.sessions.selectedChat,
			setSelectedChatId: (id) => deps.sessions.setSelectedChatId(id),
			reconcileProcessing: (activeChatIds) => deps.sessions.reconcileProcessing(activeChatIds),
			setChatProcessing: (chatId, isProcessing) =>
				deps.sessions.setChatProcessing(chatId, isProcessing),
			patchChatPreview: (chatId, content, _timestamp) => {
				deps.sessions.patchPreview(chatId, content);
			},
			refreshChats: () => {
				void deps.sessions.quietRefreshChats();
			},
			navigateToChat: (chatId) => {
				goto(`/chat/${chatId}`);
				void deps.sessions.quietRefreshChats();
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
		},
		startup: {
			startupCoordinator: deps.startupCoordinator,
			onLocalStartupConfirmed: (chatId) => {
				deps.sessions.setChatProcessing(chatId, true);
				deps.lifecycle.setCurrentChatId(chatId);
				deps.sessions.setSelectedChatId(chatId);
				goto(`/chat/${chatId}`);
				void deps.sessions.quietRefreshChats();
			},
			onExternalChatCreated: (chatId) => {
				if (!deps.sessions.hasChat(chatId)) {
					void deps.sessions.quietRefreshChats();
				}
			},
		},
		readState: {
			enqueueReadReceipt: (chatId, readAt) => {
				deps.readReceiptOutbox.enqueue(chatId, readAt);
				deps.sessions.patchLastReadAt(chatId, readAt);
			},
		},
	};
}

// Mounts the event router by assembling the store contract and invoking
// createEventRouter. Must be called during component initialization
// (inside a Svelte 5 $effect scope).
export function mountConversationRouter(deps: ConversationRouterDeps): void {
	const stores = buildRouterStores(deps);
	createEventRouter(deps.ws, deps.drainHandle, stores);
}
