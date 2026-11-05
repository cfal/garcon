// Svelte 5 rune-based event router. Drains the WsConnection message log
// on each messageVersion tick, normalizes events, filters by active chat,
// and dispatches to handler functions.

import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ServerWsMessage, EventKey } from '$shared/ws-events';
import {
	ChatTranscriptHeadUpdatedMessage,
	ChatInputCommittedMessage,
	ChatDisplayStateUpdatedMessage,
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
import type { PermissionMode } from '$lib/types/chat';
import type { ActiveTranscriptPort } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import {
	clearPendingChatId,
	getPendingChatId,
	setPendingChatId,
} from '$lib/chat/conversation/pending-chat-handoff.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions-contract.js';
import { applyTranscriptHeadActivity } from '$lib/chat/sessions/chat-message-batch-activity.js';
import type { ResponseClassOrdinals } from '$shared/transcript-display-events';
import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import { PlanPresentationController } from '$lib/chat/conversation/plan-presentation-controller.js';
import { getChatSnapshot } from '$lib/api/chats.js';

import { untrack } from 'svelte';
import { normalizeEvent } from '$lib/ws/normalize';
import { filterByChat } from './chat-filter';

import { handleAgentComplete, handleAgentError, type LifecycleContext } from './handlers/lifecycle';
import { syncPermissionWaitingStatus } from './handlers/permissions';
import { handleExecutionControlUpdated, type QueueContext } from './handlers/queue';
import { operationalNoticeContent } from './handlers/operational-notice';
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
	permissionMode: (chatId: string) => PermissionMode | null;
	setPermissionMode: (chatId: string, mode: PermissionMode) => void;
}

export type EventRouterSessionsStore = Pick<
	ChatSessionsPort,
	| 'byId'
	| 'selectedChat'
	| 'setSelectedChatId'
	| 'patchPreview'
	| 'patchActivity'
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
	'getCursor' | 'appendLocalNotice' | 'appendServerNotice' | 'loadMessages'
> & {
	getChatCursor: (chatId: string) => { transcriptViewId: string; lastOrdinal: number } | null;
	reloadChatTranscript: (chatId: string) => void;
	isRenderedChat: (chatId: string) => boolean;
	loadRenderedChat: (chatId: string) => Promise<void> | void;
	markRenderedChatStale: (chatId: string) => void;
	removeChatTranscript: (chatId: string) => void;
	markChatTranscriptStale: (chatId: string) => void;
	observeHead: (chatId: string, view: string, ordinal: number, responseTypes: ResponseClassOrdinals) => void;
	acknowledgeInput: (chatId: string, view: string, id: string, ordinal: number) => void;
	displayReady: (message: ChatDisplayStateUpdatedMessage) => void;
	observeOpenSnapshots: (listener: (snapshot: DisplayOpenResponse) => void) => () => void;
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
		chatId: string,
		entry: import('$lib/chat/conversation/conversation-lifecycle-state.svelte.js').LoadingStatusEntry,
	) => void;
	popLoadingStatus: (chatId: string, id: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
}

export interface EventRouterStartupStore {
	startupCoordinator: StartupCoordinator;
}

export interface EventRouterReadStateStore {
	enqueueReadReceipt: (chatId: string, readAt: string) => void;
}

export interface EventRouterChatPresentations {
	clearDeletedChat: (chatId: string) => void;
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
	chatPresentations: EventRouterChatPresentations;
	notifyCompletion: (chatId: string) => void;
}

// Creates helper functions used by multiple handler contexts.
function createHelpers(stores: EventRouterStores) {
	const clearTurnStatus = (chatId?: string | null) => {
		if (chatId) stores.lifecycle.clearTurnStatus(chatId);
	};
	const isChatProcessing = (chatId?: string | null) =>
		Boolean(chatId && stores.sessions.isChatProcessing(chatId));

	return { clearTurnStatus, isChatProcessing };
}

// Builds the dispatch table mapping EventKey to handler functions.
function buildDispatch(
	stores: EventRouterStores,
	plans: PlanPresentationController,
): Partial<Record<EventKey, (msg: ServerWsMessage) => void>> {
	const { clearTurnStatus, isChatProcessing } = createHelpers(stores);

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
		notifyCompletion: stores.notifyCompletion,
	};

	const chatEventCtx: ChatEventContext = {
		getSelectedChat: () => stores.sessions.selectedChat,
		getCurrentChatId: stores.lifecycle.currentChatId,
		setCurrentChatId: stores.lifecycle.setCurrentChatId,
		appendLocalNotice: stores.chatState.appendLocalNotice,
		conversationUi: stores.conversationUi,
		startupCoordinator: stores.startup.startupCoordinator,
		refreshChats: () => { void stores.sessions.quietRefreshChats(); },
		getPendingChatId,
		setPendingChatId,
		clearPendingChatId,
	};

	const queueCtx: QueueContext = {
		conversationUi: stores.conversationUi,
	};

	const sidebarCtx: SidebarContext = {
		removeChat: (chatId) => stores.sessions.removeChat(chatId),
		navigateAwayFromChat: stores.navigation.navigateAwayFromChat,
		patchChatTitle: (chatId, title) => stores.sessions.patchChat(chatId, { title }),
		patchChatProjectPath: (chatId, patch) => stores.sessions.patchChat(chatId, patch),
		patchLastReadAt: (chatId, lastReadAt) => stores.sessions.patchLastReadAt(chatId, lastReadAt),
		refreshChats: () => {
			void stores.sessions.quietRefreshChats();
		},
		removeChatTranscript: stores.chatState.removeChatTranscript,
		clearChatPresentations: stores.chatPresentations.clearDeletedChat,
	};
	const transientTranscriptViews = new Map<string, string>();

	const refreshTransientFeed = (chatId: string, requestedTranscriptViewId: string) => {
		const knownTranscriptViewId = transientTranscriptViews.get(chatId);
		if (knownTranscriptViewId && knownTranscriptViewId !== requestedTranscriptViewId) return;
		transientTranscriptViews.set(chatId, requestedTranscriptViewId);
		const previousTranscriptViewId =
			stores.conversationUi.getTransientFeed(chatId)?.transcriptViewId;
		void getChatSnapshot(chatId, 0)
			.then((snapshot) => {
				if (transientTranscriptViews.get(chatId) !== requestedTranscriptViewId) return;
				const result = stores.conversationUi.setTransientFeedFromSnapshot(snapshot.transientFeed);
				if (result.kind !== 'applied') return;
				const snapshotTranscriptViewId = snapshot.transientFeed.transcriptViewId;
				transientTranscriptViews.set(chatId, snapshotTranscriptViewId);
				if (
					(previousTranscriptViewId && previousTranscriptViewId !== snapshotTranscriptViewId) ||
					requestedTranscriptViewId !== snapshotTranscriptViewId
				)
					handleViewTransition(chatId, snapshotTranscriptViewId);
			})
			.catch(() => undefined);
	};

	const handleViewTransition = (chatId: string, transcriptViewId: string) => {
		const selectedChatId = stores.sessions.selectedChat?.id ?? null;
		const cursor = stores.chatState.getChatCursor(chatId);
		if (cursor?.transcriptViewId === transcriptViewId) {
			return;
		}
		if (stores.chatState.isRenderedChat(chatId)) {
			stores.chatState.markRenderedChatStale(chatId);
			void stores.chatState.loadRenderedChat(chatId);
			return;
		}
		stores.chatState.markChatTranscriptStale(chatId);
		if (selectedChatId === chatId) stores.chatState.reloadChatTranscript(chatId);
	};

	return {
		'chat-transcript-head-updated': (msg) => {
			if (!(msg instanceof ChatTranscriptHeadUpdatedMessage)) return;
			const prior = stores.chatState.getChatCursor(msg.chatId);
			if (prior && prior.transcriptViewId !== msg.transcriptViewId) handleViewTransition(msg.chatId, msg.transcriptViewId);
			stores.chatState.observeHead(msg.chatId, msg.transcriptViewId, msg.sourceHead, msg.responseClassOrdinals);
			if (msg.planRevision > 0) plans.refresh(msg, msg.planRevision,
				prior?.transcriptViewId === msg.transcriptViewId ? prior.lastOrdinal : null);
		},
		'chat-input-committed': (msg) => {
			if (msg instanceof ChatInputCommittedMessage) stores.chatState.acknowledgeInput(msg.chatId, msg.transcriptViewId, msg.clientMessageId, msg.ordinal);
		},
		'chat-display-state-updated': (msg) => {
			if (msg instanceof ChatDisplayStateUpdatedMessage) stores.chatState.displayReady(msg);
		},
		'chat-transcript-replaced': (msg) => {
			if (!(msg instanceof ChatTranscriptReplacedMessage)) return;
			void stores.sessions.quietRefreshChats();
			transientTranscriptViews.set(msg.chatId, msg.transcriptViewId);
			stores.conversationUi.removeTransientFeed(msg.chatId);
			plans.remove(msg.chatId);
			handleViewTransition(msg.chatId, msg.transcriptViewId);
		},
		'chat-transient-feed-mutation': (msg) => {
			if (!(msg instanceof ChatTransientFeedMutationMessage)) return;
			const result = stores.conversationUi.applyTransientFeedMutation(msg);
			if (result.kind === 'snapshot-required' || result.kind === 'corrupt') {
				refreshTransientFeed(msg.chatId, msg.transcriptViewId);
			}
		},
		'agent-run-finished': (msg) => {
			if (msg instanceof AgentRunFinishedMessage) {
						handleAgentComplete(msg, lifecycleCtx);
			}
		},
		'agent-run-failed': (msg) => {
			if (msg instanceof AgentRunFailedMessage) {
						handleAgentError(msg, lifecycleCtx);
			}
		},

		'chat-session-created': (msg) => {
			if (msg instanceof ChatSessionCreatedMessage) handleChatCreated(msg, chatEventCtx);
		},
		'chat-session-stopped': (msg) => {
			if (msg instanceof ChatSessionStoppedMessage) {
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
			stores.chatState.appendServerNotice(
				msg.chatId,
				msg.noticeType,
				operationalNoticeContent(msg),
			);
		},
		'ws-fault': (msg) => {
			if (msg instanceof WsFaultMessage) {
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
				plans.remove(msg.chatId);
				transientTranscriptViews.delete(msg.chatId);
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
	const plans = new PlanPresentationController({
		isCurrent: request => {
			const transient = stores.conversationUi.getTransientFeed(request.chatId);
			if (transient) return transient.serverInstanceId === request.serverInstanceId && transient.transcriptViewId === request.transcriptViewId;
			return stores.conversationUi.isExecutionControlSocketInstanceConfirmed(request.serverInstanceId)
				&& stores.chatState.getChatCursor(request.chatId)?.transcriptViewId === request.transcriptViewId;
		},
		isRenderedChat: stores.chatState.isRenderedChat,
		getPermissionMode: stores.agentSettings.permissionMode, setPermissionMode: stores.agentSettings.setPermissionMode,
		conversationUi: stores.conversationUi, onError: (chatId, message) => stores.chatState.appendServerNotice(chatId, 'error', message),
	});
	const dispatch = buildDispatch(stores, plans);
	let waitingChats = new Set<string>();
	$effect(() => {
		const current = new Set(stores.conversationUi.pendingPermissionChatIds.filter(chatId =>
			stores.conversationUi.pendingPermissionsFor(chatId).some(request => request.control)));
		untrack(() => {
			for (const chatId of new Set([...waitingChats, ...current])) {
				if (waitingChats.has(chatId) !== current.has(chatId)) syncPermissionWaitingStatus(chatId, stores.conversationUi, stores.lifecycle);
			}
		});
		waitingChats = current;
	});
	$effect(() => {
		// Registration immediately publishes retained snapshots, just like live dispatch.
		const unsubscribe = untrack(() => stores.chatState.observeOpenSnapshots(snapshot => {
			plans.install(snapshot.plan);
		}));
		return () => { unsubscribe(); plans.destroy(); };
	});

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
				if ((event.message instanceof ChatTranscriptHeadUpdatedMessage
					|| event.message instanceof ChatInputCommittedMessage
					|| event.message instanceof ChatDisplayStateUpdatedMessage)
					&& !stores.conversationUi.acceptsTranscriptNotification(event.message.serverInstanceId)) continue;

				const selectedChat = stores.sessions.selectedChat;
				const currentChatId = stores.lifecycle.currentChatId();
				const pendingViewChatId = stores.conversationUi.pendingViewChat?.chatId || null;
				// Patch the sidebar and selected-chat read state before keyed reducers run.
				if (event.message instanceof ChatTranscriptHeadUpdatedMessage) {
					const agentMsg = event.message;
					if (agentMsg.chatId) {
						const activityTimestamp = applyTranscriptHeadActivity(
							stores.sessions,
							agentMsg,
						);

						// Enqueue read receipts for all active-chat transcript activity when visible.
						const isActiveChat = agentMsg.chatId === (selectedChat?.id || null);
						if (isActiveChat && activityTimestamp && document.visibilityState === 'visible') {
							stores.readState.enqueueReadReceipt(agentMsg.chatId, activityTimestamp);
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
