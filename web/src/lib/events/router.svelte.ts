// Svelte 5 rune-based event router. Drains the WsConnection message log
// on each messageVersion tick, normalizes events, filters by active chat,
// and dispatches to handler functions.

import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ServerWsMessage, EventKey } from '$shared/ws-events';
import {
	ChatMessagesMessage,
	ChatTranscriptReplacedMessage,
	ChatOperationalNoticeMessage,
	ChatTransientFeedMutationMessage,
	AgentRunFinishedMessage,
	AgentRunFailedMessage,
	ChatSessionCreatedMessage,
	ChatSessionStoppedMessage,
	ChatExecutionControlUpdatedMessage,
	WsFaultMessage,
	ChatTitleUpdatedMessage,
	ChatProjectPathUpdatedMessage,
	ChatSessionDeletedWsMessage,
	ChatReadUpdatedV1Message,
	ChatListRefreshRequestedMessage,
} from '$shared/ws-events';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import { AssistantMessage, UserMessage, ThinkingMessage } from '$shared/chat-types';
import type { ChatMessage, PermissionMode } from '$lib/types/chat';
import type { ActiveTranscriptPort } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import {
	clearPendingChatId,
	getPendingChatId,
	setPendingChatId,
} from '$lib/chat/conversation/pending-chat-handoff.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import { getChatSnapshot } from '$lib/api/chats.js';

import { untrack } from 'svelte';
import { normalizeEvent } from '$lib/ws/normalize';
import { filterByChat } from './chat-filter';

import { handleAgentComplete, handleAgentError, type LifecycleContext } from './handlers/lifecycle';
import { handlePlanModeMessages, type PlanModeContext } from './handlers/plan-mode';
import {
	handlePermissionLifecycleFromBatch,
	type PermissionLifecycleContext,
} from './handlers/permissions';
import {
	handleExecutionControlUpdated,
	type QueueContext,
} from './handlers/queue';
import {
	handleChatCreated,
	handleChatAborted,
	handleWsError,
	type ChatEventContext,
} from './handlers/chat';
import {
	handleChatTitle,
	handleChatDeleted,
	handleChatReadUpdated,
	handleChatProjectPathUpdated,
	handleChatListInvalidated,
	type SidebarContext,
} from './handlers/sidebar';

export interface EventRouterAgentSettings {
	permissionMode: () => PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
}

export type EventRouterSessionsStore = Pick<
	ChatSessionsPort,
	| 'selectedChat'
	| 'setSelectedChatId'
	| 'patchPreview'
	| 'quietRefreshChats'
	| 'removeChat'
	| 'patchChat'
	| 'reconcileProcessing'
	| 'isChatProcessing'
	| 'applyProcessingEvent'
	| 'patchLastReadAt'
>;

export interface EventRouterNavigation {
	navigateToChat: (chatId: string) => void;
	navigateAwayFromChat: (chatId: string) => void;
}

export type EventRouterChatStateStore = Pick<
	ActiveTranscriptPort,
	| 'getCursor'
	| 'appendLocalNotice'
	| 'appendServerNotice'
	| 'loadMessages'
> & {
	applyChatMessages: (
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
		resendCandidates: ResendCandidate[],
	) => 'applied' | 'view-changed' | 'gap-detected';
	reloadChatTranscript: (chatId: string) => void;
	warmBackgroundTranscript: (
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
	) => boolean;
	isVisiblePreviewChat: (chatId: string) => boolean;
	warmVisibleChatPreview: (
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
	) => boolean | void;
	loadVisibleChatPreview: (chatId: string) => Promise<void> | void;
	markVisibleChatPreviewStale: (chatId: string) => void;
	removeChatTranscript: (chatId: string) => void;
	markChatTranscriptStale: (chatId: string) => void;
	markChatTranscriptValidated: (chatId: string) => void;
};

export interface EventRouterLifecycleStore {
	currentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	markTurnRunning: (chatId?: string | null) => void;
	clearTurnStatus: (chatId: string) => void;
	setLoadingStatus: (
		status: { text: string; tokens: number; can_interrupt: boolean } | null,
	) => void;
	pushLoadingStatus: (
		entry: import('$lib/chat/conversation/conversation-lifecycle-state.svelte.js').LoadingStatusEntry,
	) => void;
	popLoadingStatus: (id: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
}

export interface EventRouterStartupStore {
	startupCoordinator: StartupCoordinator;
	onExternalChatCreated: (chatId: string) => void;
}

export interface EventRouterReadStateStore {
	enqueueReadReceipt: (chatId: string, readAt: string) => void;
}

// Store references required by the router to build handler contexts.
export interface EventRouterStores {
	agentSettings: EventRouterAgentSettings;
	sessions: EventRouterSessionsStore;
	navigation: EventRouterNavigation;
	chatState: EventRouterChatStateStore;
	lifecycle: EventRouterLifecycleStore;
	conversationUi: ConversationUiPort;
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
	chatState: Pick<EventRouterChatStateStore, 'applyChatMessages' | 'reloadChatTranscript'>,
) {
	let pendingMessages: TranscriptMessage[] = [];
	let pendingTranscriptViewId = '';
	let pendingChatId = '';
	let pendingFirstOrdinal = 0;
	let pendingLastOrdinal = 0;
	let pendingResendCandidates: ResendCandidate[] = [];
	let hasPending = false;

	return {
		enqueue(msg: ChatMessagesMessage) {
			if (
				hasPending &&
				(msg.transcriptViewId !== pendingTranscriptViewId ||
					msg.chatId !== pendingChatId ||
					msg.firstOrdinal > pendingLastOrdinal + 1)
			) {
				this.flush();
			}
			if (!hasPending) pendingFirstOrdinal = msg.firstOrdinal;
			hasPending = true;
			pendingTranscriptViewId = msg.transcriptViewId;
			pendingChatId = msg.chatId;
			pendingLastOrdinal = Math.max(pendingLastOrdinal, msg.lastOrdinal);
			pendingResendCandidates = msg.resendCandidates;
			pendingMessages.push(...msg.messages);
		},
		flush() {
			if (!hasPending) return;
			const messages = pendingMessages;
			const transcriptViewId = pendingTranscriptViewId;
			const chatId = pendingChatId;
			const firstOrdinal = pendingFirstOrdinal;
			const lastOrdinal = pendingLastOrdinal;
			const resendCandidates = pendingResendCandidates;
			pendingMessages = [];
			pendingTranscriptViewId = '';
			pendingChatId = '';
			pendingFirstOrdinal = 0;
			pendingLastOrdinal = 0;
			pendingResendCandidates = [];
			hasPending = false;
			const result = chatState.applyChatMessages(
				chatId,
				transcriptViewId,
				messages,
				firstOrdinal,
				lastOrdinal,
				resendCandidates,
			);
			if (result !== 'applied') {
				chatState.reloadChatTranscript(chatId);
			}
		},
	};
}

// Creates helper functions used by multiple handler contexts.
function createHelpers(stores: EventRouterStores) {
	const markTurnRunning = (chatId?: string | null) => {
		stores.lifecycle.markTurnRunning(chatId);
	};

	const clearTurnStatus = (chatId?: string | null) => {
		if (chatId) stores.lifecycle.clearTurnStatus(chatId);
	};
	const isChatProcessing = (chatId?: string | null) =>
		Boolean(chatId && stores.sessions.isChatProcessing(chatId));

	return { markTurnRunning, clearTurnStatus, isChatProcessing };
}

// Builds the dispatch table mapping EventKey to handler functions.
function buildDispatch(
	stores: EventRouterStores,
	messagesAccumulator: ReturnType<typeof createChatMessagesAccumulator>,
): Partial<Record<EventKey, (msg: ServerWsMessage) => void>> {
	const { markTurnRunning, clearTurnStatus, isChatProcessing } = createHelpers(stores);

	const onNavigateToChat = (chatId: string) => stores.navigation.navigateToChat(chatId);
	const lifecycleCtx: LifecycleContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		setCurrentChatId: stores.lifecycle.setCurrentChatId,
		appendServerNotice: stores.chatState.appendServerNotice,
		setIsSystemChatChange: stores.lifecycle.setIsSystemChatChange,
		conversationUi: stores.conversationUi,
		clearTurnStatus,
		isChatProcessing,
		onNavigateToChat,
		getPendingChatId,
		clearPendingChatId,
		markChatTranscriptValidated: stores.chatState.markChatTranscriptValidated,
	};

	const chatEventCtx: ChatEventContext = {
		getSelectedChat: () => stores.sessions.selectedChat,
		getCurrentChatId: stores.lifecycle.currentChatId,
		setCurrentChatId: stores.lifecycle.setCurrentChatId,
		appendLocalNotice: stores.chatState.appendLocalNotice,
		conversationUi: stores.conversationUi,
		startupCoordinator: stores.startup.startupCoordinator,
		onExternalChatCreated: stores.startup.onExternalChatCreated,
		getPendingChatId,
		setPendingChatId,
		clearPendingChatId,
	};

	const permLifecycleCtx: PermissionLifecycleContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		conversationUi: stores.conversationUi,
		markTurnRunning,
		pushLoadingStatus: stores.lifecycle.pushLoadingStatus,
		popLoadingStatus: stores.lifecycle.popLoadingStatus,
	};

	const queueCtx: QueueContext = {
		conversationUi: stores.conversationUi,
	};

	const planModeCtx: PlanModeContext = {
		getCurrentChatId: stores.lifecycle.currentChatId,
		getPermissionMode: stores.agentSettings.permissionMode,
		setPermissionMode: stores.agentSettings.setPermissionMode,
		conversationUi: stores.conversationUi,
	};

	const sidebarCtx: SidebarContext = {
		removeChat: (chatId) => stores.sessions.removeChat(chatId),
		navigateAwayFromChat: stores.navigation.navigateAwayFromChat,
		patchChatTitle: (chatId, title) => stores.sessions.patchChat(chatId, { title }),
		patchChatProjectPath: (chatId, patch) => stores.sessions.patchChat(chatId, patch),
		patchLastReadAt: (chatId, lastReadAt) => stores.sessions.patchLastReadAt(chatId, lastReadAt),
		refreshChats: () => { void stores.sessions.quietRefreshChats(); },
		removeChatTranscript: stores.chatState.removeChatTranscript,
	};

	const refreshTransientFeed = (chatId: string) => {
		const previousTranscriptViewId = stores.conversationUi.getTransientFeed(chatId)?.transcriptViewId;
		void getChatSnapshot(chatId, 1)
			.then((snapshot) => {
				const result = stores.conversationUi.setTransientFeedFromSnapshot(snapshot.transientFeed);
				if (result.kind === 'applied' && previousTranscriptViewId
					&& previousTranscriptViewId !== snapshot.transientFeed.transcriptViewId) {
					handleViewTransition(chatId, snapshot.transientFeed.transcriptViewId);
				}
			})
			.catch(() => undefined);
	};

	const handleViewTransition = (chatId: string, transcriptViewId: string) => {
		messagesAccumulator.flush();
		const selectedChatId = stores.sessions.selectedChat?.id ?? null;
		if (selectedChatId === chatId) {
			const cursor = stores.chatState.getCursor();
			if (cursor.transcriptViewId !== transcriptViewId) {
				stores.chatState.reloadChatTranscript(chatId);
			} else {
				stores.chatState.markChatTranscriptValidated(chatId);
			}
			return;
		}
		if (stores.chatState.isVisiblePreviewChat(chatId)) {
			stores.chatState.markVisibleChatPreviewStale(chatId);
			void stores.chatState.loadVisibleChatPreview(chatId);
		}
		stores.chatState.markChatTranscriptStale(chatId);
	};

	return {
		'chat-messages': (msg) => {
			if (!(msg instanceof ChatMessagesMessage)) return;
			messagesAccumulator.enqueue(msg);
			const batch = messagesOf(msg);
			handlePlanModeMessages(batch, planModeCtx);
			handlePermissionLifecycleFromBatch(batch, permLifecycleCtx);
		},
		'chat-transcript-replaced': (msg) => {
			if (!(msg instanceof ChatTranscriptReplacedMessage)) return;
			stores.conversationUi.removeTransientFeed(msg.chatId);
			handleViewTransition(msg.chatId, msg.transcriptViewId);
		},
		'chat-transient-feed-mutation': (msg) => {
			if (!(msg instanceof ChatTransientFeedMutationMessage)) return;
			const result = stores.conversationUi.applyTransientFeedMutation(msg);
			if (result.kind === 'snapshot-required' || result.kind === 'corrupt') {
				refreshTransientFeed(msg.chatId);
			}
		},
		'agent-run-finished': (msg) => {
			if (msg instanceof AgentRunFinishedMessage) {
				messagesAccumulator.flush();
				handleAgentComplete(msg, lifecycleCtx);
			}
		},
		'agent-run-failed': (msg) => {
			if (msg instanceof AgentRunFailedMessage) {
				messagesAccumulator.flush();
				handleAgentError(msg, lifecycleCtx);
			}
		},

		'chat-session-created': (msg) => {
			if (msg instanceof ChatSessionCreatedMessage) handleChatCreated(msg, chatEventCtx);
		},
		'chat-session-stopped': (msg) => {
			if (msg instanceof ChatSessionStoppedMessage) {
				messagesAccumulator.flush();
				handleChatAborted(msg, chatEventCtx);
			}
		},

		'chat-execution-control-updated': (msg) => {
			if (msg instanceof ChatExecutionControlUpdatedMessage) {
				handleExecutionControlUpdated(msg, queueCtx);
			}
		},
		'chat-operational-notice': (msg) => {
			if (!(msg instanceof ChatOperationalNoticeMessage)) return;
			stores.chatState.appendServerNotice(msg.chatId, msg.noticeType, msg.content);
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
		'chat-project-path-updated': (msg) => {
			if (msg instanceof ChatProjectPathUpdatedMessage)
				handleChatProjectPathUpdated(msg, sidebarCtx);
		},
		'chat-session-deleted': (msg) => {
			if (msg instanceof ChatSessionDeletedWsMessage) {
				stores.conversationUi.removeTransientFeed(msg.chatId);
				handleChatDeleted(msg, sidebarCtx);
			}
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

				const selectedChat = stores.sessions.selectedChat;
				const currentChatId = stores.lifecycle.currentChatId();
				const pendingViewChatId = stores.conversationUi.pendingViewChat?.chatId || null;
				const activeViewChatId = selectedChat?.id || currentChatId || pendingViewChatId;

				// Pre-filter: patch sidebar preview for any chat so background
				// chats update even when the filter skips full dispatch. Cached
				// background transcripts are warmed only when already contiguous.
				if (event.message instanceof ChatMessagesMessage) {
					const agentMsg = event.message;
					if (agentMsg.chatId) {
						if (agentMsg.chatId !== activeViewChatId) {
							if (stores.chatState.isVisiblePreviewChat(agentMsg.chatId)) {
								const applied = stores.chatState.warmVisibleChatPreview(
									agentMsg.chatId,
									agentMsg.transcriptViewId,
									agentMsg.messages,
									agentMsg.firstOrdinal,
									agentMsg.lastOrdinal,
								);
								if (applied === false) {
									stores.chatState.markVisibleChatPreviewStale(agentMsg.chatId);
									void stores.chatState.loadVisibleChatPreview(agentMsg.chatId);
								}
							}
							stores.chatState.warmBackgroundTranscript(
								agentMsg.chatId,
								agentMsg.transcriptViewId,
								agentMsg.messages,
								agentMsg.firstOrdinal,
								agentMsg.lastOrdinal,
							);
						}
						const preview = selectPreviewFromBatch(agentMsg.messages.map((entry) => entry.message));
						if (preview) {
							stores.sessions.patchPreview(agentMsg.chatId, preview.content, preview.timestamp);

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
