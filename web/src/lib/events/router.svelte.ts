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
import type { SessionAgentId } from '$lib/types/app';
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

// Store references required by the router to build handler contexts.
export interface EventRouterStores {
	agentId: () => SessionAgentId;
	selectedChat: () => ChatSessionRouterView | null;
	currentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	chatMessages: () => ChatMessage[];
	setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
	appendChatMessagesByIdentity: (messages: ChatMessage[]) => void;
	pendingUserInputs: () => PendingUserInput[];
	setPendingUserInputs: (inputs: PendingUserInput[]) => void;
	upsertPendingUserInput: (input: PendingUserInput) => void;
	clearPendingUserInput: (clientRequestId: string) => void;
	updatePendingUserInputDeliveryStatus: (
		clientRequestId: string,
		deliveryStatus: 'submitting' | 'accepted' | 'failed',
	) => void;
	loadMessages: (chatId: string, options?: { minimumLimit?: number }) => Promise<ChatMessage[]>;
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
	setSelectedChatId: (chatId: string | null) => void;
	conversationUi: ConversationUiStore;
	permissionMode: () => PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
	patchChatPreview: (chatId: string, content: string, timestamp: string) => void;
	refreshChats: () => void;
	hasChat: (chatId: string) => boolean;
	navigateToChat?: (chatId: string) => void;
	removeChat: (chatId: string) => void;
	patchChatTitle: (chatId: string, title: string) => void;
	navigateAwayFromChat: (chatId: string) => void;
	// Startup ownership.
	startupCoordinator: StartupCoordinator;
	onLocalStartupConfirmed: (chatId: string) => void;
	onExternalChatCreated: (chatId: string) => void;
	// Session store reconciliation for chat-sessions-running snapshot
	reconcileProcessing: (runningChatIds: Set<string>) => void;
	setChatProcessing: (chatId: string, isProcessing: boolean) => void;
	// Read state for unread indicators
	patchLastReadAt: (chatId: string, lastReadAt: string) => void;
	enqueueReadReceipt: (chatId: string, readAt: string) => void;
	// Snapshot cache operations for lifecycle and sidebar handlers.
	removeChatSnapshot?: (chatId: string) => void;
	markChatSnapshotValidated?: (chatId: string) => void;
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
	stores: Pick<EventRouterStores, 'appendChatMessagesByIdentity'>,
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
			stores.appendChatMessagesByIdentity(messages);
		},
	};
}

function markPendingUserInputDelivery(
	clientRequestId: string | undefined,
	stores: EventRouterStores,
	deliveryStatus: 'accepted' | 'failed',
) {
	if (!clientRequestId) return;
	stores.updatePendingUserInputDeliveryStatus(clientRequestId, deliveryStatus);
}

// Creates helper functions used by multiple handler contexts.
function createHelpers(stores: EventRouterStores) {
	const activateLoadingFor = (_chatId?: string | null) => {
		stores.setIsLoading(true);
	};

	const clearLoadingIndicators = (_chatId?: string | null) => {
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
function buildDispatch(
	stores: EventRouterStores,
	outputAccumulator: ReturnType<typeof createAgentOutputAccumulator>,
): Partial<Record<EventKey, (msg: ServerWsMessage) => void>> {
	const { activateLoadingFor, clearLoadingIndicators, markChatsAsCompleted } =
		createHelpers(stores);

	const onNavigateToChat = stores.navigateToChat
		? (chatId: string) => stores.navigateToChat!(chatId)
		: undefined;
	const onChatProcessing = (chatId?: string | null) => {
		if (chatId) stores.setChatProcessing(chatId, true);
	};
	const onChatNotProcessing = (chatId?: string | null) => {
		if (chatId) stores.setChatProcessing(chatId, false);
	};

	const lifecycleCtx: LifecycleContext = {
		getCurrentChatId: stores.currentChatId,
		setCurrentChatId: stores.setCurrentChatId,
		setChatMessages: stores.setChatMessages,
		setIsSystemChatChange: stores.setIsSystemChatChange,
		conversationUi: stores.conversationUi,
		clearLoadingIndicators,
		markChatsAsCompleted,
		onNavigateToChat,
		getPendingChatId,
		clearPendingChatId,
		markChatSnapshotValidated: stores.markChatSnapshotValidated,
	};

	const chatEventCtx: ChatEventContext = {
		getSelectedChat: stores.selectedChat,
		getCurrentChatId: stores.currentChatId,
		setCurrentChatId: stores.setCurrentChatId,
		setChatMessages: stores.setChatMessages,
		loadMessages: stores.loadMessages,
		setIsSystemChatChange: stores.setIsSystemChatChange,
		conversationUi: stores.conversationUi,
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
		getCurrentChatId: stores.currentChatId,
		conversationUi: stores.conversationUi,
		activateLoadingFor,
		setCanAbort: stores.setCanAbort,
		pushLoadingStatus: stores.pushLoadingStatus,
		popLoadingStatus: stores.popLoadingStatus,
	};

	const queueCtx: QueueContext = {
		getCurrentChatId: stores.currentChatId,
		getSelectedChatId: () => stores.selectedChat()?.id || null,
		conversationUi: stores.conversationUi,
		activateLoadingFor,
		setCanAbort: stores.setCanAbort,
		onChatProcessing,
	};

	const planModeCtx: PlanModeContext = {
		getCurrentChatId: stores.currentChatId,
		getPermissionMode: stores.permissionMode,
		setPermissionMode: stores.setPermissionMode,
		conversationUi: stores.conversationUi,
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
		removeChatSnapshot: stores.removeChatSnapshot,
	};

	return {
		'agent-run-output': (msg) => {
			if (!(msg instanceof AgentRunOutputMessage)) return;
			activateLoadingFor(msg.chatId);
			stores.setCanAbort(true);
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
			stores.setIsSystemChatChange(true);
			stores.setCurrentChatId(msg.chatId);
			stores.setSelectedChatId(msg.chatId);
			stores.refreshChats();
			stores.navigateToChat?.(msg.chatId);
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
			const sendChatId = msg.chatId || stores.currentChatId();
			if (sendChatId && msg.content) {
				stores.patchChatPreview(
					sendChatId,
					String(msg.content).slice(0, 200),
					new Date().toISOString(),
				);
			}
		},
		'pending-user-input-updated': (msg) => {
			if (!(msg instanceof PendingUserInputUpdatedMessage)) return;
			stores.upsertPendingUserInput(msg.input);
		},
		'pending-user-input-cleared': (msg) => {
			if (!(msg instanceof PendingUserInputClearedMessage)) return;
			outputAccumulator.flush();
			if (msg.reason !== 'persisted') {
				stores.clearPendingUserInput(msg.clientRequestId);
				return;
			}
			void stores
				.loadMessages(msg.chatId)
				.then((messages) => {
					if (stores.currentChatId() && stores.currentChatId() !== msg.chatId) return;
					stores.setChatMessages(messages);
					stores.clearPendingUserInput(msg.clientRequestId);
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
	const outputAccumulator = createAgentOutputAccumulator(stores);
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

				const selectedChat = stores.selectedChat();
				const currentChatId = stores.currentChatId();
				const pendingViewChatId = stores.conversationUi.pendingViewChat?.chatId || null;

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

			outputAccumulator.flush();
		});
	});
}

export { extractFirstLine as _extractFirstLine };
