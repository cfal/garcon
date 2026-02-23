// Svelte 5 rune-based event router. Drains the WsConnection message log
// on each messageVersion tick, normalizes events, filters by active chat,
// and dispatches to handler functions.

import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ServerWsMessage, EventKey } from '$shared/ws-events';
import {
	AgentRunOutputMessage,
	AgentRunFinishedMessage,
	AgentRunFailedMessage,
	ChatSessionCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	QueueStateUpdatedMessage,
	QueueDispatchingMessage,
	ChatSessionsRunningMessage,
	WsFaultMessage,
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
} from '$shared/ws-events';
import { AssistantMessage, UserMessage, ThinkingMessage } from '$shared/chat-types';
import type { ChatMessage, PendingPermissionRequest, PendingViewChat, PermissionMode, QueueState } from '$lib/types/chat';
import type { ChatEntry, SessionProvider } from '$lib/types/app';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';

import { untrack } from 'svelte';
import { normalizeEvent } from '$lib/ws/normalize';
import { filterByChat } from './chat-filter';
import { applyChatMessages } from './reducer';

import {
	handleAgentComplete,
	handleAgentError,
	type LifecycleContext,
} from './handlers/lifecycle';
import { handlePlanModeMessages, type PlanModeContext } from './handlers/plan-mode';
import { handlePermissionLifecycleFromBatch, type PermissionLifecycleContext } from './handlers/permissions';
import { handleQueueUpdated, handleQueueSending, type QueueContext } from './handlers/queue';
import { handleChatCreated, handleChatAborted, handleChatStatus, handleWsError, type ChatEventContext } from './handlers/chat';
import { handleRunningChats, type RunningChatsContext } from './handlers/chat-sessions-running';
import {
	handleChatTitle,
	handleChatDeleted,
	handleChatReadUpdated,
	handleChatListInvalidated,
	type SidebarContext,
} from './handlers/sidebar';

// Store references required by the router to build handler contexts.
export interface EventRouterStores {
	provider: () => SessionProvider;
	selectedChat: () => ChatEntry | null;
	currentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	chatMessages: () => ChatMessage[];
	setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
	loadMessages: (chatId: string, loadMore?: boolean, provider?: string) => Promise<ChatMessage[]>;
	setIsLoading: (v: boolean) => void;
	setCanAbort: (v: boolean) => void;
	setLoadingStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
	pushLoadingStatus: (entry: import('$lib/stores/chat-lifecycle.svelte').LoadingStatusEntry) => void;
	popLoadingStatus: (id: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
	pendingPermissionRequests: () => PendingPermissionRequest[];
	setPendingPermissionRequests: (
		updater: PendingPermissionRequest[] | ((prev: PendingPermissionRequest[]) => PendingPermissionRequest[]),
	) => void;
	pendingViewChat: () => PendingViewChat | null;
	setPendingViewChat?: (v: PendingViewChat | null) => void;
	setMessageQueue: (chatId: string, queue: QueueState | null) => void;
	permissionMode: () => PermissionMode;
	previousPermissionMode: () => PermissionMode | null;
	setPermissionMode: (mode: PermissionMode) => void;
	setPreviousPermissionMode: (mode: PermissionMode | null) => void;
	patchChatPreview: (chatId: string, content: string, timestamp: string) => void;
	refreshChats: () => void;
	hasChat: (chatId: string) => boolean;
	navigateToChat?: (chatId: string) => void;
	removeChat: (chatId: string) => void;
	patchChatTitle: (chatId: string, title: string) => void;
	navigateAwayFromChat: (chatId: string) => void;
	// Startup ownership (replaces legacy replaceTemporaryChat).
	startupCoordinator: StartupCoordinator;
	onLocalStartupConfirmed: (chatId: string) => void;
	onExternalChatCreated: (chatId: string) => void;
	// Session store reconciliation for chat-sessions-running snapshot
	reconcileProcessing: (runningChatIds: Set<string>) => void;
	setChatProcessing: (chatId: string, isProcessing: boolean) => void;
	// Read state for unread indicators
	patchLastReadAt: (chatId: string, lastReadAt: string) => void;
	enqueueReadReceipt: (chatId: string, readAt: string) => void;
}

function extractFirstLine(text: string): string {
	if (!text) return '';
	const nl = text.indexOf('\n');
	if (nl < 0) return text.trim();
	return text.slice(0, nl).trim();
}

// Extracts sidebar preview content from an incoming message batch.
// Only considers finalized types (not partials) so background chats
// update on completed messages. Returns null if the batch contains
// no displayable content.
export function selectPreviewFromBatch(
	messages: ChatMessage[],
): { content: string; timestamp: string } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg instanceof AssistantMessage || msg instanceof UserMessage || msg instanceof ThinkingMessage) {
			return {
				content: extractFirstLine(String(msg.content || '')).slice(0, 200),
				timestamp: msg.timestamp,
			};
		}
	}
	return null;
}

// Applies server-provided ChatMessage[] from a broadcast envelope.
// Sidebar preview is handled by the pre-filter in createEventRouter
// which runs for all chats (including background ones).
function applyServerMessages(
	msg: AgentRunOutputMessage,
	stores: EventRouterStores,
) {
	if (msg.messages.length === 0) return;
	const current = stores.chatMessages();
	const updated = applyChatMessages(current, msg.messages);
	stores.setChatMessages(updated);
}

// Creates helper functions used by multiple handler contexts.
function createHelpers(stores: EventRouterStores) {
	const activateLoadingFor = (chatId?: string | null) => {
		stores.setIsLoading(true);
	};

	const clearLoadingIndicators = (chatId?: string | null) => {
		stores.setIsLoading(false);
		stores.setCanAbort(false);
		stores.setLoadingStatus(null);
	};

	const markChatsAsCompleted = (...chatIds: Array<string | null | undefined>) => {
		const unique = new Set(
			chatIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
		);
		for (const id of unique) {
			stores.setChatProcessing(id, false);
		}
	};

	return { activateLoadingFor, clearLoadingIndicators, markChatsAsCompleted };
}

// Builds the dispatch table mapping EventKey to handler functions.
function buildDispatch(stores: EventRouterStores): Partial<Record<EventKey, (msg: ServerWsMessage) => void>> {
	const { activateLoadingFor, clearLoadingIndicators, markChatsAsCompleted } = createHelpers(stores);

	const selectedChat = stores.selectedChat();
	const currentChatId = stores.currentChatId();
	const provider = stores.provider();
	const projectPath = selectedChat?.projectPath || null;

	const onNavigateToChat = stores.navigateToChat
		? (chatId: string) => stores.navigateToChat!(chatId)
		: undefined;
	const onChatProcessing = (chatId?: string | null) => {
		if (chatId) stores.setChatProcessing(chatId, true);
	};
	const onChatNotProcessing = (chatId?: string | null) => {
		if (chatId) stores.setChatProcessing(chatId, false);
	};

	// Centralized pendingChatId access via sessionStorage.
	const getPendingChatId = (): string | null => {
		try { return typeof window !== 'undefined' ? sessionStorage.getItem('pendingChatId') : null; }
		catch { return null; }
	};
	const setPendingChatId = (id: string) => {
		try { if (typeof window !== 'undefined') sessionStorage.setItem('pendingChatId', id); }
		catch { /* storage unavailable */ }
	};
	const clearPendingChatId = () => {
		try { if (typeof window !== 'undefined') sessionStorage.removeItem('pendingChatId'); }
		catch { /* storage unavailable */ }
	};

	const lifecycleCtx: LifecycleContext = {
		currentChatId,
		setCurrentChatId: stores.setCurrentChatId,
		setChatMessages: stores.setChatMessages,
		setIsSystemChatChange: stores.setIsSystemChatChange,
		setPendingPermissionRequests: stores.setPendingPermissionRequests,
		clearLoadingIndicators,
		markChatsAsCompleted,
		onNavigateToChat,
		getPendingChatId,
		clearPendingChatId,
	};

	const chatEventCtx: ChatEventContext = {
		provider,
		projectPath,
		selectedChat,
		getCurrentChatId: stores.currentChatId,
		setCurrentChatId: stores.setCurrentChatId,
		setChatMessages: stores.setChatMessages,
		loadMessages: stores.loadMessages,
		setIsSystemChatChange: stores.setIsSystemChatChange,
		setPendingPermissionRequests: stores.setPendingPermissionRequests,
		pendingViewChat: stores.pendingViewChat(),
		setPendingViewChat: stores.setPendingViewChat,
		activateLoadingFor,
		clearLoadingIndicators,
		markChatsAsCompleted,
		setCanAbort: stores.setCanAbort,
		onChatProcessing,
		onChatNotProcessing,
		startupCoordinator: stores.startupCoordinator,
		onLocalStartupConfirmed: stores.onLocalStartupConfirmed,
		onExternalChatCreated: stores.onExternalChatCreated,
		getPendingChatId,
		setPendingChatId,
		clearPendingChatId,
	};

	const permLifecycleCtx: PermissionLifecycleContext = {
		currentChatId,
		setPendingPermissionRequests: (updater) => {
			if (typeof updater === 'function') {
				stores.setPendingPermissionRequests(updater);
			}
		},
		activateLoadingFor,
		setCanAbort: stores.setCanAbort,
		pushLoadingStatus: stores.pushLoadingStatus,
		popLoadingStatus: stores.popLoadingStatus,
	};

	const queueCtx: QueueContext = {
		currentChatId,
		selectedChatId: selectedChat?.id || null,
		setChatMessages: stores.setChatMessages,
		setMessageQueue: stores.setMessageQueue,
		activateLoadingFor,
		setCanAbort: stores.setCanAbort,
		onChatProcessing,
	};

	const planModeCtx: PlanModeContext = {
		currentChatId,
		permissionMode: stores.permissionMode(),
		setPermissionMode: stores.setPermissionMode,
		setPreviousPermissionMode: stores.setPreviousPermissionMode,
		setPendingPermissionRequests: (updater) => {
			if (typeof updater === 'function') {
				stores.setPendingPermissionRequests(updater);
			}
		},
	};

	const runningCtx: RunningChatsContext = {
		reconcileProcessing: stores.reconcileProcessing,
	};

	const sidebarCtx: SidebarContext = {
		removeChat: stores.removeChat,
		navigateAwayFromChat: stores.navigateAwayFromChat,
		patchChatTitle: stores.patchChatTitle,
		patchLastReadAt: stores.patchLastReadAt,
		refreshChats: stores.refreshChats,
	};

	return {
		'agent-run-output': (msg) => {
			if (!(msg instanceof AgentRunOutputMessage)) return;
			activateLoadingFor(msg.chatId);
			stores.setCanAbort(true);
			onChatProcessing(msg.chatId);
			applyServerMessages(msg, stores);
			handlePlanModeMessages(msg, planModeCtx);
			handlePermissionLifecycleFromBatch(msg, permLifecycleCtx);
		},
		'agent-run-finished': (msg) => {
			if (msg instanceof AgentRunFinishedMessage) handleAgentComplete(msg, lifecycleCtx);
		},
		'agent-run-failed': (msg) => {
			if (msg instanceof AgentRunFailedMessage) handleAgentError(msg, lifecycleCtx);
		},

		'chat-session-created': (msg) => {
			if (msg instanceof ChatSessionCreatedMessage) handleChatCreated(msg, chatEventCtx);
		},
		'chat-session-stopped': (msg) => {
			if (msg instanceof ChatSessionStoppedMessage) handleChatAborted(msg, chatEventCtx);
		},
		'chat-processing-updated': (msg) => {
			if (msg instanceof ChatProcessingUpdatedMessage) handleChatStatus(msg, chatEventCtx);
		},

		'queue-state-updated': (msg) => {
			if (msg instanceof QueueStateUpdatedMessage) handleQueueUpdated(msg, queueCtx);
		},
		'queue-dispatching': (msg) => {
			if (!(msg instanceof QueueDispatchingMessage)) return;
			handleQueueSending(msg, queueCtx);
			const sendChatId = msg.chatId || currentChatId;
			if (sendChatId && msg.content) {
				stores.patchChatPreview(
					sendChatId,
					String(msg.content).slice(0, 200),
					new Date().toISOString(),
				);
			}
		},
		'chat-sessions-running': (msg) => {
			if (msg instanceof ChatSessionsRunningMessage) handleRunningChats(msg, runningCtx);
		},
		'ws-fault': (msg) => {
			if (msg instanceof WsFaultMessage) handleWsError(msg, chatEventCtx);
		},

		'chat-title-updated': (msg) => {
			if (msg instanceof ChatTitleUpdatedMessage) handleChatTitle(msg, sidebarCtx);
		},
		'chat-session-deleted': (msg) => {
			if (msg instanceof ChatSessionDeletedWsMessage) handleChatDeleted(msg, sidebarCtx);
		},
		'chat-read-updated-v1': (msg) => {
			if (msg instanceof ChatReadUpdatedV1Message) handleChatReadUpdated(msg, sidebarCtx);
		},
		'chat-list-refresh-requested': (msg) => {
			if (msg instanceof ChatListRefreshRequestedMessage) handleChatListInvalidated(msg, sidebarCtx);
		},
	};
}

// Creates a Svelte 5 $effect that drains the WsConnection on each
// messageVersion tick and dispatches normalized events to handlers.
// Returns a cleanup function to unregister the drain cursor.
export function createEventRouter(
	connection: WsConnection,
	drainHandle: DrainHandle,
	stores: EventRouterStores,
): void {
	$effect(() => {
		// Sole tracked dependency: re-run whenever a new WS message arrives.
		// All store reads and handler dispatches are untracked so that
		// writes from handlers (setChatProcessing, patchPreview, etc.)
		// don't re-trigger this effect through shared byId dependencies.
		const _version = connection.messageVersion;

		untrack(() => {
			const newMessages = drainHandle.drain();
			if (newMessages.length === 0) return;

			const dispatch = buildDispatch(stores);

			const selectedChat = stores.selectedChat();
			const currentChatId = stores.currentChatId();
			const pendingViewChatId = stores.pendingViewChat()?.chatId || null;

			for (const wsMsg of newMessages) {
				const event = normalizeEvent(wsMsg.data);
				if (!event) continue;

				// Pre-filter: patch sidebar preview for any chat so background
				// chats update even when the filter skips full dispatch.
				if (event.message instanceof AgentRunOutputMessage) {
					const agentMsg = event.message;
					if (agentMsg.chatId && agentMsg.messages.length > 0) {
						const preview = selectPreviewFromBatch(agentMsg.messages);
						if (preview) {
							stores.patchChatPreview(agentMsg.chatId, preview.content, preview.timestamp);

							// Enqueue read receipt for the active chat when visible.
							const isActiveChat = agentMsg.chatId === (selectedChat?.id || null);
							if (isActiveChat && document.visibilityState === 'visible') {
								stores.enqueueReadReceipt(agentMsg.chatId, preview.timestamp);
							}
						}
					}
				}

				const filterResult = filterByChat(event.key, event.message, {
					selectedChatId: selectedChat?.id || null,
					currentChatId,
					pendingViewChatId,
				});

				if (filterResult.action === 'skip') continue;

				const handler = dispatch[event.key];
				if (handler) handler(event.message);
			}
		});
	});
}

export { extractFirstLine as _extractFirstLine };
