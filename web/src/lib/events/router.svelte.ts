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
	ChatForkCreatedMessage,
	ChatSessionStoppedMessage,
	ChatProcessingUpdatedMessage,
	QueueStateUpdatedMessage,
	QueueDispatchingMessage,
	PendingUserInputUpdatedMessage,
	PendingUserInputClearedMessage,
	ChatSessionsRunningMessage,
	WsFaultMessage,
	ChatTitleUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
} from '$shared/ws-events';
import { AssistantMessage, UserMessage, ThinkingMessage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import type { ChatMessage, PermissionMode } from '$lib/types/chat';
import type { ChatSessionRouterView } from '$lib/types/chat-session';
import type { StartupCoordinator } from '$lib/chat/startup-coordinator';
import { clearPendingChatId, getPendingChatId, setPendingChatId } from '$lib/chat/pending-chat-handoff';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';

import { untrack } from 'svelte';
import { normalizeEvent } from '$lib/ws/normalize';
import { filterByChat } from './chat-filter';

import { handleAgentComplete, handleAgentError, type LifecycleContext } from './handlers/lifecycle';
import { handlePlanModeMessages, type PlanModeContext } from './handlers/plan-mode';
import {
	handlePermissionLifecycleFromBatch,
	type PermissionLifecycleContext,
} from './handlers/permissions';
import { handleQueueUpdated, handleQueueSending, type QueueContext } from './handlers/queue';
import {
	handleChatCreated,
	handleChatAborted,
	handleChatStatus,
	handleWsError,
	type ChatEventContext,
} from './handlers/chat';
import { handleRunningChats, type RunningChatsContext } from './handlers/chat-sessions-running';
import {
	handleChatTitle,
	handleChatDeleted,
	handleChatReadUpdated,
	handleChatListInvalidated,
	type SidebarContext,
} from './handlers/sidebar';

export interface EventRouterAgentSettings {
	permissionMode: () => PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
}

export interface EventRouterSessionsStore {
	selectedChat: () => ChatSessionRouterView | null;
	setSelectedChatId: (chatId: string | null) => void;
	patchChatPreview: (chatId: string, content: string, timestamp: string) => void;
	refreshChats: () => void;
	navigateToChat?: (chatId: string) => void;
	removeChat: (chatId: string) => void;
	patchChatTitle: (chatId: string, title: string) => void;
	navigateAwayFromChat: (chatId: string) => void;
	reconcileProcessing: (runningChatIds: Set<string>) => void;
	setChatProcessing: (chatId: string, isProcessing: boolean) => void;
	patchLastReadAt: (chatId: string, lastReadAt: string) => void;
}

export interface EventRouterChatStateStore {
	setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
	appendChatMessagesByIdentity: (messages: ChatMessage[]) => void;
	upsertPendingUserInput: (input: PendingUserInput) => void;
	clearPendingUserInput: (clientRequestId: string) => void;
	updatePendingUserInputDeliveryStatus: (
		clientRequestId: string,
		deliveryStatus: 'submitting' | 'accepted' | 'failed',
	) => void;
	loadMessages: (chatId: string, options?: { minimumLimit?: number }) => Promise<ChatMessage[]>;
	removeChatSnapshot?: (chatId: string) => void;
	markChatSnapshotValidated?: (chatId: string) => void;
}

export interface EventRouterLifecycleStore {
	currentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	setIsLoading: (v: boolean) => void;
	setCanAbort: (v: boolean) => void;
	setLoadingStatus: (
		status: { text: string; tokens: number; can_interrupt: boolean } | null,
	) => void;
	pushLoadingStatus: (
		entry: import('$lib/stores/chat-lifecycle.svelte').LoadingStatusEntry,
	) => void;
	popLoadingStatus: (id: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
}

export interface EventRouterStartupStore {
	startupCoordinator: StartupCoordinator;
	onLocalStartupConfirmed: (chatId: string) => void;
	onExternalChatCreated: (chatId: string) => void;
}

export interface EventRouterReadStateStore {
	enqueueReadReceipt: (chatId: string, readAt: string) => void;
}

// Store references required by the router to build handler contexts.
export interface EventRouterStores {
	agentSettings: EventRouterAgentSettings;
	sessions: EventRouterSessionsStore;
	chatState: EventRouterChatStateStore;
	lifecycle: EventRouterLifecycleStore;
	conversationUi: ConversationUiStore;
	startup: EventRouterStartupStore;
	readState: EventRouterReadStateStore;
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
		if (
			msg instanceof AssistantMessage ||
			msg instanceof UserMessage ||
			msg instanceof ThinkingMessage
		) {
			return {
				content: extractFirstLine(String(msg.content || '')).slice(0, 200),
				timestamp: msg.timestamp,
			};
		}
	}
	return null;
}

// Coalesces output chunks from one drain pass into one message-array write.
export function createAgentOutputAccumulator(
	chatState: Pick<EventRouterChatStateStore, 'appendChatMessagesByIdentity'>,
) {
	let pendingMessages: ChatMessage[] = [];

	return {
		enqueue(msg: AgentRunOutputMessage) {
			if (msg.messages.length === 0) return;
			pendingMessages.push(...msg.messages);
		},
		flush() {
			if (pendingMessages.length === 0) return;
			const messages = pendingMessages;
			pendingMessages = [];
			chatState.appendChatMessagesByIdentity(messages);
		},
	};
}

function markPendingUserInputDelivery(
	clientRequestId: string | undefined,
	stores: EventRouterStores,
	deliveryStatus: 'accepted' | 'failed',
) {
	if (!clientRequestId) return;
	stores.chatState.updatePendingUserInputDeliveryStatus(clientRequestId, deliveryStatus);
}

// Creates helper functions used by multiple handler contexts.
function createHelpers(stores: EventRouterStores) {
	const activateLoadingFor = (_chatId?: string | null) => {
		stores.lifecycle.setIsLoading(true);
	};

	const clearLoadingIndicators = (_chatId?: string | null) => {
		stores.lifecycle.setIsLoading(false);
		stores.lifecycle.setCanAbort(false);
		stores.lifecycle.setLoadingStatus(null);
	};

	const markChatsAsCompleted = (...chatIds: Array<string | null | undefined>) => {
		const unique = new Set(
			chatIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
		);
		for (const id of unique) {
			stores.sessions.setChatProcessing(id, false);
		}
	};

	return { activateLoadingFor, clearLoadingIndicators, markChatsAsCompleted };
}

// Builds the dispatch table mapping EventKey to handler functions.
function buildDispatch(
	stores: EventRouterStores,
	outputAccumulator: ReturnType<typeof createAgentOutputAccumulator>,
): Partial<Record<EventKey, (msg: ServerWsMessage) => void>> {
	const { activateLoadingFor, clearLoadingIndicators, markChatsAsCompleted } =
		createHelpers(stores);

	const onNavigateToChat = stores.sessions.navigateToChat
		? (chatId: string) => stores.sessions.navigateToChat!(chatId)
		: undefined;
	const onChatProcessing = (chatId?: string | null) => {
		if (chatId) stores.sessions.setChatProcessing(chatId, true);
	};
	const onChatNotProcessing = (chatId?: string | null) => {
		if (chatId) stores.sessions.setChatProcessing(chatId, false);
	};

	const lifecycleCtx: LifecycleContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		setCurrentChatId: stores.lifecycle.setCurrentChatId,
		setChatMessages: stores.chatState.setChatMessages,
		setIsSystemChatChange: stores.lifecycle.setIsSystemChatChange,
		conversationUi: stores.conversationUi,
		clearLoadingIndicators,
		markChatsAsCompleted,
		onNavigateToChat,
		getPendingChatId,
		clearPendingChatId,
		markChatSnapshotValidated: stores.chatState.markChatSnapshotValidated,
	};

	const chatEventCtx: ChatEventContext = {
		getSelectedChat: stores.sessions.selectedChat,
		getCurrentChatId: stores.lifecycle.currentChatId,
		setCurrentChatId: stores.lifecycle.setCurrentChatId,
		setChatMessages: stores.chatState.setChatMessages,
		loadMessages: stores.chatState.loadMessages,
		setIsSystemChatChange: stores.lifecycle.setIsSystemChatChange,
		conversationUi: stores.conversationUi,
		activateLoadingFor,
		clearLoadingIndicators,
		markChatsAsCompleted,
		setCanAbort: stores.lifecycle.setCanAbort,
		onChatProcessing,
		onChatNotProcessing,
		startupCoordinator: stores.startup.startupCoordinator,
		onLocalStartupConfirmed: stores.startup.onLocalStartupConfirmed,
		onExternalChatCreated: stores.startup.onExternalChatCreated,
		getPendingChatId,
		setPendingChatId,
		clearPendingChatId,
	};

	const permLifecycleCtx: PermissionLifecycleContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		conversationUi: stores.conversationUi,
		activateLoadingFor,
		setCanAbort: stores.lifecycle.setCanAbort,
		pushLoadingStatus: stores.lifecycle.pushLoadingStatus,
		popLoadingStatus: stores.lifecycle.popLoadingStatus,
	};

	const queueCtx: QueueContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		getSelectedChatId: () => stores.sessions.selectedChat()?.id || null,
		conversationUi: stores.conversationUi,
		activateLoadingFor,
		setCanAbort: stores.lifecycle.setCanAbort,
		onChatProcessing,
	};

	const planModeCtx: PlanModeContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		getPermissionMode: stores.agentSettings.permissionMode,
		setPermissionMode: stores.agentSettings.setPermissionMode,
		conversationUi: stores.conversationUi,
	};

	const runningCtx: RunningChatsContext = {
		reconcileProcessing: stores.sessions.reconcileProcessing,
	};

	const sidebarCtx: SidebarContext = {
		removeChat: stores.sessions.removeChat,
		navigateAwayFromChat: stores.sessions.navigateAwayFromChat,
		patchChatTitle: stores.sessions.patchChatTitle,
		patchLastReadAt: stores.sessions.patchLastReadAt,
		refreshChats: stores.sessions.refreshChats,
		removeChatSnapshot: stores.chatState.removeChatSnapshot,
	};

	return {
		'agent-run-output': (msg) => {
			if (!(msg instanceof AgentRunOutputMessage)) return;
			activateLoadingFor(msg.chatId);
			stores.lifecycle.setCanAbort(true);
			onChatProcessing(msg.chatId);
			markPendingUserInputDelivery(msg.clientRequestId, stores, 'accepted');
			outputAccumulator.enqueue(msg);
			handlePlanModeMessages(msg, planModeCtx);
			handlePermissionLifecycleFromBatch(msg, permLifecycleCtx);
		},
		'agent-run-finished': (msg) => {
			if (msg instanceof AgentRunFinishedMessage) {
				outputAccumulator.flush();
				markPendingUserInputDelivery(msg.clientRequestId, stores, 'accepted');
				handleAgentComplete(msg, lifecycleCtx);
			}
		},
		'agent-run-failed': (msg) => {
			if (msg instanceof AgentRunFailedMessage) {
				outputAccumulator.flush();
				markPendingUserInputDelivery(msg.clientRequestId, stores, 'failed');
				handleAgentError(msg, lifecycleCtx);
			}
		},

		'chat-session-created': (msg) => {
			if (msg instanceof ChatSessionCreatedMessage) handleChatCreated(msg, chatEventCtx);
		},
		'chat-fork-created': (msg) => {
			if (!(msg instanceof ChatForkCreatedMessage)) return;
			stores.lifecycle.setIsSystemChatChange(true);
			stores.lifecycle.setCurrentChatId(msg.chatId);
			stores.sessions.setSelectedChatId(msg.chatId);
			stores.sessions.refreshChats();
			stores.sessions.navigateToChat?.(msg.chatId);
		},
		'chat-session-stopped': (msg) => {
			if (msg instanceof ChatSessionStoppedMessage) {
				outputAccumulator.flush();
				handleChatAborted(msg, chatEventCtx);
			}
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
			const sendChatId = msg.chatId || stores.lifecycle.currentChatId();
			if (sendChatId && msg.content) {
				stores.sessions.patchChatPreview(
					sendChatId,
					String(msg.content).slice(0, 200),
					new Date().toISOString(),
				);
			}
		},
		'pending-user-input-updated': (msg) => {
			if (!(msg instanceof PendingUserInputUpdatedMessage)) return;
			stores.chatState.upsertPendingUserInput(msg.input);
		},
		'pending-user-input-cleared': (msg) => {
			if (!(msg instanceof PendingUserInputClearedMessage)) return;
			outputAccumulator.flush();
			if (msg.reason !== 'persisted') {
				stores.chatState.clearPendingUserInput(msg.clientRequestId);
				return;
			}
			void stores.chatState
				.loadMessages(msg.chatId)
				.then((messages) => {
					if (stores.lifecycle.currentChatId() && stores.lifecycle.currentChatId() !== msg.chatId)
						return;
					stores.chatState.setChatMessages(messages);
					stores.chatState.clearPendingUserInput(msg.clientRequestId);
				})
				.catch(() => {
					// The local pending overlay remains visible until the next successful reload.
				});
		},
		'chat-sessions-running': (msg) => {
			if (msg instanceof ChatSessionsRunningMessage) handleRunningChats(msg, runningCtx);
		},
		'ws-fault': (msg) => {
			if (msg instanceof WsFaultMessage) {
				outputAccumulator.flush();
				handleWsError(msg, chatEventCtx);
			}
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
			if (msg instanceof ChatListRefreshRequestedMessage)
				handleChatListInvalidated(msg, sidebarCtx);
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
	const outputAccumulator = createAgentOutputAccumulator(stores.chatState);
	const dispatch = buildDispatch(stores, outputAccumulator);

	$effect(() => {
		// Sole tracked dependency: re-run whenever a new WS message arrives.
		// All store reads and handler dispatches are untracked so that
		// writes from handlers (setChatProcessing, patchPreview, etc.)
		// don't re-trigger this effect through shared byId dependencies.
		const _version = connection.messageVersion;

		untrack(() => {
			const newMessages = drainHandle.drain();
			if (newMessages.length === 0) return;

			for (const wsMsg of newMessages) {
				const event = normalizeEvent(wsMsg.data);
				if (!event) continue;

				const selectedChat = stores.sessions.selectedChat();
				const currentChatId = stores.lifecycle.currentChatId();
				const pendingViewChatId = stores.conversationUi.pendingViewChat?.chatId || null;

				// Pre-filter: patch sidebar preview for any chat so background
				// chats update even when the filter skips full dispatch.
				if (event.message instanceof AgentRunOutputMessage) {
					const agentMsg = event.message;
					if (agentMsg.chatId && agentMsg.messages.length > 0) {
						const preview = selectPreviewFromBatch(agentMsg.messages);
						if (preview) {
							stores.sessions.patchChatPreview(
								agentMsg.chatId,
								preview.content,
								preview.timestamp,
							);

							// Enqueue read receipt for the active chat when visible.
							const isActiveChat = agentMsg.chatId === (selectedChat?.id || null);
							if (isActiveChat && document.visibilityState === 'visible') {
								stores.readState.enqueueReadReceipt(agentMsg.chatId, preview.timestamp);
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

			outputAccumulator.flush();
		});
	});
}

export { extractFirstLine as _extractFirstLine };
