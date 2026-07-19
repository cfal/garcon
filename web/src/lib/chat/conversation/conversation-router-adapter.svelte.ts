// Assembles the EventRouterStores contract from workspace dependencies
// and mounts the WS event router. Isolates protocol-store wiring from
// the UI component so ConversationWorkspace stays composition-focused.

import { goto } from '$app/navigation';
import { createEventRouter, type EventRouterStores } from '$lib/events/router.svelte';
import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ActiveTranscriptState } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatViewMessage } from '$shared/chat-view';
import type {
	ChatTranscriptApplyResult,
	ChatTranscriptCache,
} from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { BackgroundTranscriptLoader } from '$lib/chat/transcript/background-transcript-loader.js';

export interface ConversationRouterStoreDeps {
	sessions: {
		selectedChat: ChatSessionRecord | null;
		selectedChatId: string | null;
		byId: Record<string, ChatSessionRecord>;
		order: string[];
		hasChat: (chatId: string) => boolean;
		patchPreview: (chatId: string, content: string, timestamp?: string) => void;
		patchChat: (chatId: string, patch: Partial<ChatSessionRecord>) => void;
		patchLastReadAt: (chatId: string, lastReadAt: string) => void;
		removeChat: (chatId: string) => void;
		setSelectedChatId: (id: string | null) => void;
		applyProcessingEvent: (chatId: string, isProcessing: boolean) => void;
		reconcileProcessing: (activeChatIds: Set<string>) => void;
		quietRefreshChats: () => Promise<void> | void;
	};
	chatState: ActiveTranscriptState;
	agentState: AgentState;
	lifecycle: ConversationLifecycleState;
	conversationUi: ConversationUiState;
	startupCoordinator: StartupCoordinator;
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	transcriptCache?: ChatTranscriptCache;
	backgroundTranscriptLoader?: Pick<BackgroundTranscriptLoader, 'queueLoad'>;
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

export interface ConversationRouterDeps extends ConversationRouterStoreDeps {
	ws: WsConnection;
	drainHandle: DrainHandle;
}

function routerApplyStatus(
	result: ChatTranscriptApplyResult,
): 'applied' | 'generation-changed' | 'gap-detected' {
	if (result.status === 'applied') return 'applied';
	if (result.status === 'generation-changed') return 'generation-changed';
	return 'gap-detected';
}

// Assembles the EventRouterStores contract from workspace dependencies.
export function buildRouterStores(deps: ConversationRouterStoreDeps): EventRouterStores {
	const transcriptCache = deps.transcriptCache ?? deps.chatState.transcriptCache;
	const queueBackgroundLoad = (
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
	): void => {
		deps.backgroundTranscriptLoader?.queueLoad(chatId, { generationId, messages });
	};
	const applyBackgroundTranscript = (
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
	): ChatTranscriptApplyResult => {
		const result = transcriptCache.applyMessages(chatId, generationId, messages);
		if (result.status !== 'applied') {
			queueBackgroundLoad(chatId, generationId, messages);
		}
		return result;
	};
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
				if (deps.sessions.selectedChatId !== chatId) {
					return routerApplyStatus(applyBackgroundTranscript(chatId, generationId, messages));
				}
				return deps.chatState.applyMessages(chatId, generationId, messages);
			},
			reloadChatTranscript: (chatId) => {
				if (deps.sessions.selectedChatId !== chatId) return;
				void deps.chatState.loadMessages(chatId).catch(() => {
					// Leaves current visible state until a later retry succeeds.
				});
			},
			warmBackgroundTranscript: (chatId, generationId, messages) =>
				applyBackgroundTranscript(chatId, generationId, messages).status === 'applied',
			isVisiblePreviewChat: (chatId) => deps.visiblePreviews?.isVisible(chatId) ?? false,
			warmVisibleChatPreview: (chatId, generationId, messages) =>
				deps.visiblePreviews?.applyMessages(chatId, generationId, messages) ?? undefined,
			loadVisibleChatPreview: (chatId) => deps.visiblePreviews?.loadSnapshot(chatId),
			markVisibleChatPreviewStale: (chatId) => {
				deps.visiblePreviews?.markStale(chatId);
			},
			appendLocalNotice: (noticeType, content) =>
				deps.chatState.appendLocalNotice(noticeType, content),
			upsertPendingUserInput: (input) => deps.chatState.upsertPendingUserInput(input),
			clearPendingUserInput: (clientRequestId) =>
				deps.chatState.clearPendingUserInput(clientRequestId),
			updatePendingUserInputDeliveryStatus: (clientRequestId, deliveryStatus) =>
				deps.chatState.updatePendingUserInputDeliveryStatus(clientRequestId, deliveryStatus),
			loadMessages: (chatId, options) => deps.chatState.loadMessages(chatId, options),
			removeChatTranscript: (chatId) => transcriptCache.remove(chatId),
			markChatTranscriptStale: (chatId) => transcriptCache.markStale(chatId),
			markChatTranscriptValidated: (chatId) => transcriptCache.markValidated(chatId),
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
				deps.sessions.applyProcessingEvent(chatId, isProcessing),
			patchChatPreview: (chatId, content, timestamp) => {
				deps.sessions.patchPreview(chatId, content, timestamp);
			},
			refreshChats: () => {
				void deps.sessions.quietRefreshChats();
			},
			navigateToChat: (chatId) => {
				void gotoChat(chatId);
			},
			removeChat: (chatId) => deps.sessions.removeChat(chatId),
			patchChatTitle: (chatId, title) => deps.sessions.patchChat(chatId, { title }),
			patchChatProjectPath: (chatId, patch) => deps.sessions.patchChat(chatId, patch),
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
