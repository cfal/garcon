// Assembles the EventRouterStores contract from workspace dependencies
// and mounts the WS event router. Isolates protocol-store wiring from
// the UI component so ConversationWorkspace stays composition-focused.

import { goto } from '$app/navigation';
import { createEventRouter, type EventRouterStores } from '$lib/events/router.svelte';
import { gotoChat } from '$lib/chat/actions/chat-navigation.js';
import type { WsConnection } from '$lib/ws/connection.svelte';
import type { DrainHandle } from '$lib/ws/drain';
import type { ActiveTranscriptPort } from '$lib/chat/transcript/active-transcript-state.svelte.js';
import type { AgentState } from '$lib/chat/conversation/agent-state.svelte.js';
import type { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import type { StartupCoordinator } from '$lib/chat/conversation/startup-coordinator.js';
import type { ChatSessionsPort } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import type {
	ChatTranscriptApplyResult,
	ChatTranscriptCache,
} from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import type { BackgroundTranscriptLoader } from '$lib/chat/transcript/background-transcript-loader.js';
import type { ChatDraftStore } from '$lib/chat/composer/chat-draft-store.svelte.js';
import type { ConversationPanelRegistry } from './conversation-panel-registry.svelte.js';
import type { ConversationLifecyclePort } from './conversation-lifecycle-registry.svelte.js';

export interface ConversationRouterStoreDeps {
	sessions: Pick<
		ChatSessionsPort,
		| 'byId'
		| 'selectedChat'
		| 'selectedChatId'
		| 'order'
		| 'hasChat'
		| 'patchPreview'
		| 'patchChat'
		| 'patchLastReadAt'
		| 'removeChat'
		| 'setSelectedChatId'
		| 'isChatProcessing'
		| 'applyProcessingEvent'
		| 'reconcileProcessing'
		| 'quietRefreshChats'
	>;
	chatState: ActiveTranscriptPort;
	agentState: AgentState;
	lifecycle: Pick<
		ConversationLifecycleState,
		| 'currentChatId'
		| 'setCurrentChatId'
		| 'markTurnRunning'
		| 'clearTurnStatus'
		| 'setLoadingStatus'
		| 'pushLoadingStatus'
		| 'popLoadingStatus'
		| 'setIsSystemChatChange'
	>;
	lifecycles: Pick<ConversationLifecyclePort, 'forChat' | 'get'>;
	conversationUi: ConversationUiPort;
	startupCoordinator: StartupCoordinator;
	readReceiptOutbox: { enqueue: (chatId: string, readAt: string) => void };
	notifyCompletion: () => void;
	transcriptCache?: ChatTranscriptCache;
	backgroundTranscriptLoader?: Pick<BackgroundTranscriptLoader, 'queueLoad'>;
	chatDrafts?: Pick<ChatDraftStore, 'discardChat'>;
	panels?: ConversationPanelRegistry;
	clearDeletedChat: (chatId: string) => void;
}

export interface ConversationRouterDeps extends ConversationRouterStoreDeps {
	ws: WsConnection;
	drainHandle: DrainHandle;
}

function routerApplyStatus(
	result: ChatTranscriptApplyResult,
): 'applied' | 'view-changed' | 'gap-detected' {
	if (result.status === 'applied') return 'applied';
	if (result.status === 'view-changed') return 'view-changed';
	return 'gap-detected';
}

// Assembles the EventRouterStores contract from workspace dependencies.
export function buildRouterStores(deps: ConversationRouterStoreDeps): EventRouterStores {
	const transcriptCache = deps.transcriptCache ?? deps.chatState.transcriptCache;
	const queueBackgroundLoad = (
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
	): void => {
		deps.backgroundTranscriptLoader?.queueLoad(chatId, {
			transcriptViewId,
			messages,
			firstOrdinal,
			lastOrdinal,
		});
	};
	const applyBackgroundTranscript = (
		chatId: string,
		transcriptViewId: string,
		messages: TranscriptMessage[],
		firstOrdinal: number,
		lastOrdinal: number,
	): ChatTranscriptApplyResult => {
		const result = transcriptCache.applyMessages(chatId, transcriptViewId, {
			messages,
			firstOrdinal,
			lastOrdinal,
		});
		if (result.status !== 'applied') {
			queueBackgroundLoad(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal);
		}
		return result;
	};
	return {
		agentSettings: {
			permissionMode: (chatId) => {
				const chat = deps.sessions.byId[chatId];
				if (!chat) return null;
				return deps.sessions.selectedChatId === chatId
					? deps.agentState.permissionMode
					: chat.permissionMode;
			},
			setPermissionMode: (chatId, mode) => {
				if (!deps.sessions.byId[chatId]) return;
				deps.sessions.patchChat(chatId, { permissionMode: mode });
				if (deps.sessions.selectedChatId === chatId) deps.agentState.permissionMode = mode;
			},
		},
		chatState: {
			getCursor: () => deps.chatState.getCursor(),
			getChatCursor: (chatId) => {
				if (!deps.panels && deps.sessions.selectedChatId === chatId) {
					return deps.chatState.getCursor();
				}
				return transcriptCache.readAppliedCursor(chatId);
			},
			applyChatMessages: (
				chatId,
				transcriptViewId,
				messages,
				firstOrdinal,
				lastOrdinal,
				resendCandidates: ResendCandidate[],
			) => {
				if (deps.panels) {
					const result = deps.panels.applyCommittedBatch({
						chatId,
						transcriptViewId,
						messages,
						firstOrdinal,
						lastOrdinal,
						resendCandidates,
						noticeRevision: deps.panels.noticeRevisionFor(chatId),
					});
					if (result.kind === 'applied') {
						return result.localRecoverySurfaceIds.length === 0
							? 'applied'
							: 'gap-detected';
					}
					return result.outcome.status === 'view-changed'
						? 'view-changed'
						: 'gap-detected';
				}
				if (deps.sessions.selectedChatId !== chatId) {
					return routerApplyStatus(
						applyBackgroundTranscript(
							chatId,
							transcriptViewId,
							messages,
							firstOrdinal,
							lastOrdinal,
						),
					);
				}
				return deps.chatState.applyMessages(
					chatId,
					transcriptViewId,
					messages,
					firstOrdinal,
					lastOrdinal,
					resendCandidates,
				);
			},
			reloadChatTranscript: (chatId) => {
				if (deps.panels) {
					void deps.panels.loadChatSnapshot(chatId).catch(() => {});
					return;
				}
				if (deps.sessions.selectedChatId !== chatId) return;
				void deps.chatState.loadMessages(chatId).catch(() => {
					// Leaves current visible state until a later retry succeeds.
				});
			},
			isRenderedChat: (chatId) =>
				(deps.panels?.panelsForChat(chatId).length ?? 0) > 0,
			loadRenderedChat: async (chatId) => {
				try {
					await deps.panels?.loadChatSnapshot(chatId);
				} catch {
					// Leaves the stale cache flag set so a later activation retries.
				}
			},
			markRenderedChatStale: (chatId) => {
				deps.panels?.handleViewReplacement(chatId);
			},
			appendLocalNotice: (noticeType, content) => {
				const chatId = deps.sessions.selectedChatId;
				if (deps.panels && chatId) deps.panels.appendLocalNotice(chatId, noticeType, content);
				else deps.chatState.appendLocalNotice(noticeType, content);
			},
			appendServerNotice: (chatId, noticeType, content) =>
				deps.panels
					? deps.panels.appendServerNotice(chatId, noticeType, content)
					: deps.chatState.appendServerNotice(chatId, noticeType, content),
			loadMessages: (chatId, options) => deps.chatState.loadMessages(chatId, options),
			removeChatTranscript: (chatId) => {
				if (deps.panels) deps.panels.removeChat(chatId);
				else {
					transcriptCache.remove(chatId);
					deps.chatState.discardServerNotices(chatId);
				}
				deps.chatDrafts?.discardChat(chatId);
			},
			markChatTranscriptStale: (chatId) => {
				if (deps.panels) deps.panels.markChatStale(chatId);
				else transcriptCache.markStale(chatId);
			},
			markChatTranscriptValidated: (chatId) => transcriptCache.markValidated(chatId),
		},
		lifecycle: {
			currentChatId: () => deps.lifecycle.currentChatId,
			setCurrentChatId: (id) => deps.lifecycle.setCurrentChatId(id),
			markTurnRunning: (chatId) => deps.lifecycle.markTurnRunning(chatId),
			clearTurnStatus: (chatId) => deps.lifecycle.clearTurnStatus(chatId),
			setLoadingStatus: (s) => deps.lifecycle.setLoadingStatus(s),
			pushLoadingStatus: (chatId, entry) =>
				deps.lifecycles.forChat(chatId).pushLoadingStatus(entry),
			popLoadingStatus: (chatId, id) => deps.lifecycles.get(chatId)?.popLoadingStatus(id),
			setIsSystemChatChange: (v) => deps.lifecycle.setIsSystemChatChange(v),
		},
		conversationUi: deps.conversationUi,
		sessions: deps.sessions,
		navigation: {
			navigateToChat: (chatId) => {
				void gotoChat(chatId);
			},
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
		chatPresentations: {
			clearDeletedChat: deps.clearDeletedChat,
		},
		notifyCompletion: deps.notifyCompletion,
	};
}

// Mounts the event router by assembling the store contract and invoking
// createEventRouter. Must be called during component initialization
// (inside a Svelte 5 $effect scope).
export function mountConversationRouter(deps: ConversationRouterDeps): void {
	const stores = buildRouterStores(deps);
	createEventRouter(deps.ws, deps.drainHandle, stores);
}
