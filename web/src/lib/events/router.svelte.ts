// Svelte 5 rune-based event router. Drains the WsConnection message log
// on each messageVersion tick, normalizes events, filters by active chat,
// and dispatches to handler functions.

import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ServerWsMessage, EventKey } from '$shared/ws-events';
import {
	ChatMessagesMessage,
	ChatGenerationResetMessage,
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
import type { ChatViewMessage } from '$shared/chat-view';
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
	getCursor: () => { generationId: string; lastSeq: number };
	applyChatMessages: (
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
	) => 'applied' | 'generation-changed';
	reloadChatSnapshot: (chatId: string) => void;
	appendErrorMessage: (content: string) => void;
	appendLocalAssistantMessage: (content: string) => void;
	upsertPendingUserInput: (input: PendingUserInput) => void;
	clearPendingUserInput: (clientRequestId: string) => void;
	updatePendingUserInputDeliveryStatus: (
		clientRequestId: string,
		deliveryStatus: 'submitting' | 'accepted' | 'failed',
	) => void;
	loadMessages: (chatId: string, options?: { minimumLimit?: number }) => Promise<ChatMessage[]>;
	removeChatSnapshot?: (chatId: string) => void;
	markChatSnapshotStale?: (chatId: string) => void;
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

export function createChatMessagesAccumulator(
	chatState: Pick<EventRouterChatStateStore, 'applyChatMessages' | 'reloadChatSnapshot'>,
) {
	let pendingMessages: ChatViewMessage[] = [];
	let pendingGenerationId = '';
	let pendingChatId = '';

	return {
		enqueue(msg: ChatMessagesMessage) {
			if (msg.messages.length === 0) return;
			if (pendingMessages.length > 0 && msg.generationId !== pendingGenerationId) {
				this.flush();
			}
			pendingGenerationId = msg.generationId;
			pendingChatId = msg.chatId;
			pendingMessages.push(...msg.messages);
		},
		flush() {
			if (pendingMessages.length === 0) return;
			const messages = pendingMessages;
			const generationId = pendingGenerationId;
			const chatId = pendingChatId;
			pendingMessages = [];
			pendingGenerationId = '';
			pendingChatId = '';
			const result = chatState.applyChatMessages(chatId, generationId, messages);
			if (result === 'generation-changed') {
				chatState.reloadChatSnapshot(chatId);
			}
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
	messagesAccumulator: ReturnType<typeof createChatMessagesAccumulator>,
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
		appendErrorMessage: stores.chatState.appendErrorMessage,
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
		appendErrorMessage: stores.chatState.appendErrorMessage,
		appendLocalAssistantMessage: stores.chatState.appendLocalAssistantMessage,
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
		'chat-messages': (msg) => {
			if (!(msg instanceof ChatMessagesMessage)) return;
			activateLoadingFor(msg.chatId);
			stores.lifecycle.setCanAbort(true);
			onChatProcessing(msg.chatId);
			markPendingUserInputDelivery(msg.clientRequestId, stores, 'accepted');
			messagesAccumulator.enqueue(msg);
			const batch = messagesOf(msg);
			handlePlanModeMessages(batch, planModeCtx);
			handlePermissionLifecycleFromBatch(batch, permLifecycleCtx);
		},
		'chat-generation-reset': (msg) => {
			if (!(msg instanceof ChatGenerationResetMessage)) return;
			messagesAccumulator.flush();
			const selectedChatId = stores.sessions.selectedChat()?.id ?? null;
			if (selectedChatId === msg.chatId) {
				const cursor = stores.chatState.getCursor();
				if (cursor.generationId !== msg.generationId) {
					stores.chatState.reloadChatSnapshot(msg.chatId);
				} else {
					stores.chatState.markChatSnapshotValidated?.(msg.chatId);
				}
				return;
			}
			stores.chatState.markChatSnapshotStale?.(msg.chatId);
		},
		'agent-run-finished': (msg) => {
			if (msg instanceof AgentRunFinishedMessage) {
				messagesAccumulator.flush();
				markPendingUserInputDelivery(msg.clientRequestId, stores, 'accepted');
				handleAgentComplete(msg, lifecycleCtx);
			}
		},
		'agent-run-failed': (msg) => {
			if (msg instanceof AgentRunFailedMessage) {
				messagesAccumulator.flush();
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
				messagesAccumulator.flush();
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
			messagesAccumulator.flush();
			stores.chatState.clearPendingUserInput(msg.clientRequestId);
		},
		'chat-sessions-running': (msg) => {
			if (msg instanceof ChatSessionsRunningMessage) handleRunningChats(msg, runningCtx);
		},
		'ws-fault': (msg) => {
			if (msg instanceof WsFaultMessage) {
				messagesAccumulator.flush();
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
	const messagesAccumulator = createChatMessagesAccumulator(stores.chatState);
	const dispatch = buildDispatch(stores, messagesAccumulator);

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
				if (event.message instanceof ChatMessagesMessage) {
					const agentMsg = event.message;
					if (agentMsg.chatId && agentMsg.messages.length > 0) {
						const preview = selectPreviewFromBatch(agentMsg.messages.map((entry) => entry.message));
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

			messagesAccumulator.flush();
		});
		});
	}

export { extractFirstLine as _extractFirstLine };

function messagesOf(msg: ChatMessagesMessage): { chatId: string; messages: ChatMessage[] } {
	return {
		chatId: msg.chatId,
		messages: msg.messages.map((entry) => entry.message),
	};
}
