// Assembles the EventRouterStores contract from workspace dependencies
// and mounts the WS event router. Isolates protocol-store wiring from
// the UI component so ConversationWorkspace stays composition-focused.

import { goto } from '$app/navigation';
import { createEventRouter, type EventRouterStores } from '$lib/events/router.svelte';
import { gotoChat } from '$lib/chat/chat-navigation';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import { INITIAL_VISIBLE_MESSAGES, type ChatState } from '$lib/chat/state.svelte';
import type { AgentState } from '$lib/chat/agent-state.svelte';
import type { ChatLifecycleStore } from '$lib/stores/chat-lifecycle.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatViewMessage } from '$shared/chat-view';

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
	visiblePreviews?: {
		isVisible: (chatId: string) => boolean;
		applyMessages: (
			chatId: string,
			generationId: string,
			messages: ChatViewMessage[],
		) => boolean | void;
		loadSnapshot: (chatId: string) => Promise<void> | void;
		markStale: (chatId: string) => void;
	};
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
			getCursor: () => deps.chatState.getCursor(),
			applyChatMessages: (chatId, generationId, messages) => {
				if (deps.sessions.selectedChatId !== chatId) return 'applied';
				return deps.chatState.applyMessages(generationId, messages);
			},
			reloadChatSnapshot: (chatId) => {
				if (deps.sessions.selectedChatId !== chatId) return;
				void deps.chatState.loadMessages(chatId).catch(() => {
					// Leaves current visible state until a later retry succeeds.
				});
			},
			warmBackgroundChatSnapshot: (chatId, generationId, messages) =>
				deps.chatState.snapshotCache.applyMessages(chatId, generationId, messages, undefined, {
					limit: INITIAL_VISIBLE_MESSAGES,
				}),
			isVisiblePreviewChat: (chatId) => deps.visiblePreviews?.isVisible(chatId) ?? false,
			warmVisibleChatPreview: (chatId, generationId, messages) =>
				deps.visiblePreviews?.applyMessages(chatId, generationId, messages),
			loadVisibleChatPreview: (chatId) => deps.visiblePreviews?.loadSnapshot(chatId),
			markVisibleChatPreviewStale: (chatId) => deps.visiblePreviews?.markStale(chatId),
			appendLocalNotice: (noticeType, content) =>
				deps.chatState.appendLocalNotice(noticeType, content),
			upsertPendingUserInput: (input) => deps.chatState.upsertPendingUserInput(input),
			clearPendingUserInput: (clientRequestId) =>
				deps.chatState.clearPendingUserInput(clientRequestId),
			updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) =>
				deps.chatState.updatePendingUserInputDeliveryStatus(clientRequestId, deliveryStatus),
			loadMessages: (chatId, options) => deps.chatState.loadMessages(chatId, options),
			removeChatSnapshot: (chatId) => deps.chatState.snapshotCache.remove(chatId),
			markChatSnapshotStale: (chatId) => deps.chatState.snapshotCache.markStale(chatId),
			markChatSnapshotValidated: (chatId) => deps.chatState.snapshotCache.markValidated(chatId),
		},
		lifecycle: {
			currentChatId: () => deps.lifecycle.currentChatId,
			setCurrentChatId: (id) => deps.lifecycle.setCurrentChatId(id),
			markTurnRunning: (chatId) => deps.lifecycle.markTurnRunning(chatId),
			clearTurnStatus: () => deps.lifecycle.clearTurnStatus(),
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
				void gotoChat(chatId);
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
					void gotoChat(neighborId);
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
				void gotoChat(chatId);
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
