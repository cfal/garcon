import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/svelte';

import {
	ChatReconnectCoordinator,
	type ChatReconnectCoordinatorOptions,
	type ReconnectPanelRegistryPort,
} from '../reconnect-coordinator.svelte.ts';
import type { ChatExecutionControlState } from '$shared/chat-execution-control';
import ReconnectCoordinatorTestHost from './ReconnectCoordinatorTestHost.svelte';
import { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import { AssistantMessage } from '$shared/chat-types';
import type { WsMessageConsumer } from '../connection.svelte.js';
import type { CompleteChatHistoryResponse, ResendCandidate, TranscriptMessage } from '$shared/chat-view';
import * as chatsApi from '$lib/api/chats.js';
import { ChatTranscriptCache } from '$lib/chat/transcript/chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '$lib/chat/transcript/conversation-transcript-overlay-store.svelte.js';
import { ConversationLifecycleState } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import { ConversationPanelRegistry, type ConversationPanelDescriptor, type ConversationPanelPresentationPort } from '$lib/chat/conversation/conversation-panel-registry.svelte.js';

const TS = '2024-01-01T00:00:00.000Z';

function controlState(
	paused: boolean,
	serverInstanceId = 'server-instance-test',
): ChatExecutionControlState {
	return {
		serverInstanceId,
		queue: {
			entries: paused
				? [
						{
							id: 'queued-1',
							content: 'queued',
							kind: 'turn',
							attachments: [],
							revision: 1,
							createdAt: TS,
							updatedAt: TS,
						},
					]
				: [],
			steeringEntryId: null,
			recentlyDispatched: [],
			pause: paused ? { id: 'pause-1', kind: 'manual', pausedAt: TS } : null,
			reorderRevision: 0,
		},
		version: paused ? 2 : 1,
		updatedAt: TS,
	};
}

function messageJson(ordinal: number, content: string) {
	return {
		ordinal,
		message: { type: 'assistant-message', timestamp: TS, content },
	};
}

function transientFeed(chatId: string, transcriptViewId: string) {
	return {
		serverInstanceId: 'server-instance-test',
		chatId,
		transcriptViewId,
		transientRevision: 0,
		rows: [],
	};
}

function reconnectStateResponse(
	runningIds: string[] = [],
	chatIds: string[] = [],
	controlStates: Record<string, ChatExecutionControlState> | undefined = {},
	serverInstanceId = 'server-instance-test',
) {
	return {
		type: 'reconnect-state',
		clientRequestId: 'req-reconnect',
		serverInstanceId,
		processing: {
			outcome: 'snapshot',
			chats: runningIds.map((chatId) => ({ chatId, phase: 'running' })),
		},
		controlResults: chatIds.map((chatId) => ({
			chatId,
			outcome: 'snapshot',
			control: controlStates?.[chatId] ?? controlState(false),
		})),
	};
}

function deltaResponse(
	chatId: string,
	transcriptViewId = `generation-${chatId}`,
	messages: unknown[] = [],
	emptyAfterOrdinal = 2,
) {
	const first = messages[0] as { ordinal?: unknown } | undefined;
	const last = messages.at(-1) as { ordinal?: unknown } | undefined;
	const firstOrdinal = typeof first?.ordinal === 'number' ? first.ordinal : emptyAfterOrdinal + 1;
	const lastOrdinal = typeof last?.ordinal === 'number' ? last.ordinal : emptyAfterOrdinal;
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		transcriptViewId,
		messages,
		firstOrdinal,
		lastOrdinal,
		nextAfterOrdinal: lastOrdinal,
		throughOrdinal: lastOrdinal,
		hasMore: false,
		resendCandidates: [],
		transientFeed: transientFeed(chatId, transcriptViewId),
	};
}

function boundedReplayResponse(options: {
	chatId?: string;
	transcriptViewId?: string;
	afterOrdinal: number;
	nextAfterOrdinal: number;
	throughOrdinal: number;
	hasMore: boolean;
	messages?: unknown[];
}) {
	const chatId = options.chatId ?? 'chat-1';
	const transcriptViewId = options.transcriptViewId ?? 'generation-selected';
	return {
		...deltaResponse(chatId, transcriptViewId, options.messages ?? []),
		firstOrdinal: options.afterOrdinal + 1,
		lastOrdinal: options.nextAfterOrdinal,
		nextAfterOrdinal: options.nextAfterOrdinal,
		throughOrdinal: options.throughOrdinal,
		hasMore: options.hasMore,
	};
}

function snapshotRequiredResponse(
	chatId: string,
	transcriptViewId: string | null = `generation-${chatId}`,
) {
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		transcriptViewId,
		messages: [],
		firstOrdinal: 1,
		lastOrdinal: 0,
		nextAfterOrdinal: 0,
		throughOrdinal: 0,
		hasMore: false,
		resendCandidates: [],
		transientFeed: transientFeed(chatId, transcriptViewId ?? `pending:${chatId}`),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error('Condition was not reached');
}

function createReconnectDeps(
	options: {
		selectedChatId?: string | null;
		runningIds?: string[];
		subscribeResponses?: Record<string, Record<string, unknown>>;
		backgroundCursors?: Array<{ chatId: string; transcriptViewId: string; lastOrdinal: number }>;
		controlChatIds?: string[];
		controlStates?: Record<string, ChatExecutionControlState>;
	} = {},
) {
	const selectedChatId = options.selectedChatId ?? 'chat-1';
	let selectedCursor = { transcriptViewId: 'generation-selected', lastOrdinal: 2 };
	const backgroundApplied = new Map((options.backgroundCursors ?? []).map(cursor => [cursor.chatId, cursor]));
	let reconnectReplayToken = 0;
	const sendRequest = vi.fn(async (request: object) => {
		if (!('type' in request)) throw new Error('Request is missing a type');
		if (request.type === 'reconnect-state-query') {
			const chatIds =
				'controlChatIds' in request && Array.isArray(request.controlChatIds)
					? request.controlChatIds.filter((chatId): chatId is string => typeof chatId === 'string')
					: [];
			return reconnectStateResponse(options.runningIds ?? [], chatIds, options.controlStates);
		}
		if (request.type === 'chat-subscribe') {
			const chatId = 'chatId' in request ? String(request.chatId) : '';
			return options.subscribeResponses?.[chatId] ?? deltaResponse(chatId);
		}
		throw new Error(`Unexpected request: ${String(request.type)}`);
	});
	const applyMessages = vi.fn(
		(
			chatId: string,
			transcriptViewId: string,
			_messages: TranscriptMessage[],
			_firstOrdinal: number,
			lastOrdinal: number,
		) => {
			selectedCursor = { transcriptViewId, lastOrdinal };
			backgroundApplied.set(chatId, { chatId, transcriptViewId, lastOrdinal });
			return 'applied' as const;
		},
	);
	const chatState = {
		getCursor: vi.fn(() => selectedCursor),
		applyMessages,
		beginReconnectReplay: vi.fn(
			(_chatId: string, _transcriptViewId: string) => ++reconnectReplayToken,
		),
		applyReconnectReplayPage: vi.fn(
			(
				_token: number,
				chatId: string,
				transcriptViewId: string,
				messages: TranscriptMessage[],
				firstOrdinal: number,
				lastOrdinal: number,
				_resendCandidates: ResendCandidate[],
			) => applyMessages(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal),
		),
		finishReconnectReplay: vi.fn((_token: number, _chatId: string) => 'applied' as const),
		abortReconnectReplay: vi.fn((_token: number) => undefined),
		loadMessages: vi.fn(async (_chatId: string) => []),
		transcriptCache: {
			markStale: vi.fn(),
			markValidated: vi.fn(),
		},
	};
	const conversationUi = {
		executionControlChatIds: options.controlChatIds ?? [],
		removeExecutionControl: vi.fn(),
		setExecutionControlFromRefresh: vi.fn(),
		markExecutionControlSocketDisconnected: vi.fn(),
		confirmExecutionControlSocketInstance: vi.fn(),
		setTransientFeedFromSnapshot: vi.fn(),
	};
	const addMessageConsumer = vi.fn<(consumer: WsMessageConsumer) => () => void>(() => vi.fn());
	const sessions = {
		selectedChatId,
		quietRefreshChats: vi.fn(async () => undefined),
	};
	const replayTokens = new Map<string, number>();
	const panels = {
		transcriptCache: {
			readAppliedCursor: vi.fn((chatId: string) => {
				if (chatId === sessions.selectedChatId) return { ...selectedCursor, stale: false };
				const cursor = backgroundApplied.get(chatId);
				return cursor ? { ...cursor, stale: true } : null;
			}),
			markValidated: chatState.transcriptCache.markValidated,
			markStaleExcept: vi.fn<ChatTranscriptCache['markStaleExcept']>(),
			trackReplayValidation: vi.fn<ChatTranscriptCache['trackReplayValidation']>(() => ({ isCurrent: () => true, release: vi.fn() })),
		},
		visibleChatIds: vi.fn(() => (sessions.selectedChatId ? [sessions.selectedChatId] : [])),
		panelsForChat: vi.fn((chatId: string) => (chatId === sessions.selectedChatId ? [{}] : [])),
		hasInactiveWindow: vi.fn((_chatId: string) => false),
		discardFullscreenHiddenPanels: vi.fn(),
		invalidateChatSnapshot: vi.fn(),
		markChatStale: vi.fn((chatId: string) => chatState.transcriptCache.markStale(chatId)),
		loadChatSnapshot: vi.fn(async (chatId: string) => {
			await chatState.loadMessages(chatId);
			return true;
		}),
		beginReconnectReplay: vi.fn((chatId: string, transcriptViewId: string) => {
			const token = chatState.beginReconnectReplay(chatId, transcriptViewId);
			replayTokens.set(chatId, token);
			return token;
		}),
		applyReconnectReplayPage: vi.fn(
			(
				token: number,
				chatId: string,
				batch: Parameters<ReconnectPanelRegistryPort['applyReconnectReplayPage']>[2],
			) =>
				chatState.applyReconnectReplayPage(
					token,
					chatId,
					batch.transcriptViewId,
					batch.messages,
					batch.firstOrdinal,
					batch.lastOrdinal,
					batch.resendCandidates,
				),
		),
		finishReconnectReplay: vi.fn((token: number, chatId: string) => {
			const result = chatState.finishReconnectReplay(token, chatId);
			if (replayTokens.get(chatId) === token) replayTokens.delete(chatId);
			return result;
		}),
		abortReconnectReplay: vi.fn((token: number, chatId: string) => {
			chatState.abortReconnectReplay(token);
			if (replayTokens.get(chatId) === token) replayTokens.delete(chatId);
		}),
		abortReconnectReplays: vi.fn(() => {
			for (const token of replayTokens.values()) chatState.abortReconnectReplay(token);
			replayTokens.clear();
		}),
		noticeRevisionFor: vi.fn(() => 0),
		applyCommittedBatch: vi.fn(
			(batch: Parameters<ReconnectPanelRegistryPort['applyCommittedBatch']>[0]) => {
				const result = chatState.applyMessages(
					batch.chatId,
					batch.transcriptViewId,
					batch.messages,
					batch.firstOrdinal,
					batch.lastOrdinal,
				);
				if (result === 'applied') {
					return { kind: 'applied' as const, localRecoverySurfaceIds: [] };
				}
				return {
					kind: 'chat-recovery-required' as const,
					outcome:
						result === 'view-changed'
							? { status: 'view-changed' as const }
							: { status: 'gap-detected' as const, expectedOrdinal: 0, receivedOrdinal: 0 },
				};
			},
		),
	} satisfies ReconnectPanelRegistryPort;

	const deps = {
		ws: { isConnected: true as boolean, sendRequest, addMessageConsumer },
		panels,
		conversationUi,
		sessions,
		getExecutionControl: vi.fn(
			async (_chatId: string): Promise<{ control: ChatExecutionControlState }> => ({
				control: controlState(false),
			}),
		),
		getBackgroundCursors: vi.fn((limit: number) => (options.backgroundCursors ?? []).slice(0, limit)),
		markBackgroundStale: vi.fn(),
		onBackgroundMessages: vi.fn<NonNullable<ChatReconnectCoordinatorOptions['onBackgroundMessages']>>((chatId, transcriptViewId, _messages, _firstOrdinal, lastOrdinal) => {
			backgroundApplied.set(chatId, { chatId, transcriptViewId, lastOrdinal });
			return true;
		}),
	} satisfies ChatReconnectCoordinatorOptions;
	return { ...deps, chatState };
}

function clearConnectionCalls(deps: ReturnType<typeof createReconnectDeps>): void {
	for (const fn of [
		deps.ws.sendRequest,
		deps.chatState.getCursor,
		deps.chatState.applyMessages,
		deps.chatState.beginReconnectReplay,
		deps.chatState.applyReconnectReplayPage,
		deps.chatState.finishReconnectReplay,
		deps.chatState.abortReconnectReplay,
		deps.chatState.loadMessages,
		deps.chatState.transcriptCache.markStale,
		deps.chatState.transcriptCache.markValidated,
		deps.panels.transcriptCache.readAppliedCursor,
		deps.panels.transcriptCache.markStaleExcept,
		deps.panels.transcriptCache.trackReplayValidation,
		deps.panels.visibleChatIds,
		deps.panels.panelsForChat,
		deps.panels.hasInactiveWindow,
		deps.panels.markChatStale,
		deps.panels.loadChatSnapshot,
		deps.panels.beginReconnectReplay,
		deps.panels.applyReconnectReplayPage,
		deps.panels.finishReconnectReplay,
		deps.panels.abortReconnectReplay,
		deps.panels.abortReconnectReplays,
		deps.panels.noticeRevisionFor,
		deps.panels.applyCommittedBatch,
		deps.conversationUi.removeExecutionControl,
		deps.conversationUi.setExecutionControlFromRefresh,
		deps.conversationUi.markExecutionControlSocketDisconnected,
		deps.conversationUi.confirmExecutionControlSocketInstance,
		deps.getExecutionControl,
		deps.sessions.quietRefreshChats,
		deps.getBackgroundCursors,
		deps.markBackgroundStale,
		deps.onBackgroundMessages,
	]) {
		fn.mockClear();
	}
}

async function reconnectAfterFirstConnection(
	deps: ReturnType<typeof createReconnectDeps>,
): Promise<void> {
	const coordinator = new ChatReconnectCoordinator(deps);
	await coordinator.handleConnectionState(true);
	clearConnectionCalls(deps);
	await coordinator.handleConnectionState(false);
	await coordinator.handleConnectionState(true);
}

function snapshotRecoveryFixture(messageCount: number) {
	const messages = Array.from({ length: messageCount }, (_, index) => ({
		ordinal: index + 1,
		message: new AssistantMessage(TS, `row-${index + 1}`),
	}));
	const cache = new ChatTranscriptCache({ limit: 100 });
	const panels = new ConversationPanelRegistry({
		cache,
		overlays: new ConversationTranscriptOverlayStore(),
		lifecycle: { forChat: () => new ConversationLifecycleState(), remove: () => {} },
		getSelectedChatId: () => 'chat-1',
		getComposerAnchorSurfaceId: () => 'chat-view:window-one',
	});
	const descriptor = {
		surfaceId: 'chat-view:window-one', chatId: 'chat-1',
		presentation: 'window-one', windowId: 'window-one', snapshotAdmission: 'admitted',
	} satisfies ConversationPanelDescriptor;
	const page = (count: number): CompleteChatHistoryResponse => ({
		chatId: descriptor.chatId,
		transcriptViewId: 'generation-selected',
		historyState: { kind: 'complete' },
		messages: messages.slice(0, count),
		lastOrdinal: count,
		pageOldestOrdinal: 1,
		pageNewestOrdinal: count,
		nextBeforeOrdinal: null,
		hasMore: false,
		limit: 50,
		resendCandidates: [],
	});
	return { cache, panels, descriptor, messages, page };
}

describe('ChatReconnectCoordinator', () => {
	it.each([
		{ cached: false, rejects: false }, { cached: true, rejects: false },
		{ cached: false, rejects: true }, { cached: true, rejects: true },
	])('restarts a snapshot fenced by reconnect (cached: $cached, rejects: $rejects)', async ({ cached, rejects }) => {
		localStorage.clear();
		const { cache, panels, descriptor, page } = snapshotRecoveryFixture(2);
		const held = deferred<CompleteChatHistoryResponse>();
		const read = vi.spyOn(chatsApi, 'getChatMessages').mockReturnValueOnce(held.promise).mockResolvedValue(page(2));
		if (cached) cache.replaceFromPage('chat-1', page(1));
		try {
			panels.reconcile([descriptor]);
			const pending = panels.loadChatSnapshot('chat-1');
			const deps = createReconnectDeps();
			deps.ws.sendRequest.mockImplementation(async request => 'chatId' in request
				? deltaResponse('chat-1', 'generation-selected', [messageJson(2, 'row-2')])
				: reconnectStateResponse());
			const coordinator = new ChatReconnectCoordinator({ ...deps, panels });
			await coordinator.handleConnectionState(true);
			await coordinator.handleConnectionState(false);
			const reconnect = coordinator.handleConnectionState(true);
			if (cached) await reconnect;
			if (rejects) held.reject(new Error('Old connection failed'));
			else held.resolve(page(1));
			await Promise.all([pending, reconnect]);
			expect(read).toHaveBeenCalledTimes(2);
			expect(cache.get('chat-1')).toMatchObject({ stale: false, lastOrdinal: 2 });
			const transcript = panels.panel('chat-view:window-one')!.transcript;
			expect(transcript.isLoadingMessages).toBe(false);
			expect(transcript.entries.map(entry => entry.ordinal)).toEqual([1, 2]);
		} finally {
			read.mockRestore();
			panels.destroy();
			cache.flush();
			localStorage.clear();
		}
	});

	it('refreshes beyond live commits discarded after a snapshot overtakes replay', async () => {
		localStorage.clear();
		const { cache, panels, descriptor, messages, page } = snapshotRecoveryFixture(3);
		const oldSnapshot = deferred<CompleteChatHistoryResponse>();
		const replacementSnapshot = deferred<CompleteChatHistoryResponse>();
		const replay = deferred<Record<string, unknown>>();
		const read = vi.spyOn(chatsApi, 'getChatMessages')
			.mockReturnValueOnce(oldSnapshot.promise).mockReturnValueOnce(replacementSnapshot.promise)
			.mockResolvedValue(page(3));
		cache.replaceFromPage('chat-1', page(1));
		try {
			panels.reconcile([descriptor]);
			const pending = panels.loadChatSnapshot('chat-1');
			const deps = createReconnectDeps();
			deps.ws.sendRequest.mockImplementation(async request => 'chatId' in request
				? replay.promise : reconnectStateResponse());
			const invalidate = vi.spyOn(panels, 'invalidateChatSnapshot');
			const coordinator = new ChatReconnectCoordinator({ ...deps, panels });
			await coordinator.handleConnectionState(true);
			await coordinator.handleConnectionState(false);
			const reconnect = coordinator.handleConnectionState(true);
			oldSnapshot.resolve(page(1));
			await flushUntil(() => read.mock.calls.length === 2);
			expect(panels.applyCommittedBatch({ chatId: 'chat-1', transcriptViewId: 'generation-selected',
				messages: [messages[2]!], firstOrdinal: 3, lastOrdinal: 3, resendCandidates: [], noticeRevision: 0,
			})).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
			replay.resolve(deltaResponse('chat-1', 'generation-selected', [messageJson(2, 'row-2')]));
			await flushUntil(() => invalidate.mock.calls.length >= 2);
			replacementSnapshot.resolve(page(2));
			await Promise.all([pending, reconnect]);
			expect(read).toHaveBeenCalledTimes(3);
			expect(cache.get('chat-1')).toMatchObject({ stale: false, lastOrdinal: 3 });
			expect(panels.panel('chat-view:window-one')!.transcript.entries.map(entry => entry.ordinal)).toEqual([1, 2, 3]);
		} finally {
			read.mockRestore();
			panels.destroy();
			cache.flush();
			localStorage.clear();
		}
	});

	it.each(['retained', 'unmounted'] as const)('invalidates a snapshot when abandoning replay drops live commits (%s)', async presentation => {
		localStorage.clear();
		const { cache, panels, descriptor, messages, page } = snapshotRecoveryFixture(2);
		cache.replaceFromPage('chat-1', page(1));
		const replay = deferred<Record<string, unknown>>();
		const read = vi.spyOn(chatsApi, 'getChatMessages').mockResolvedValueOnce(page(1)).mockResolvedValue(page(2));
		const deps = createReconnectDeps();
		deps.ws.sendRequest.mockImplementation(async request => 'chatId' in request
			? replay.promise : reconnectStateResponse());
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });
		let reconnect: Promise<void> | undefined;
		try {
			panels.reconcile([descriptor]);
			const original = panels.panel(descriptor.surfaceId)!;
			original.attachPresentation({
				getScrollContainer: () => null, getViewport: () => null, getQueueContainer: () => undefined,
				captureRestoreTarget: () => ({ kind: 'end' }), closeTransients: () => {}, prepareForHide: () => {},
			} satisfies ConversationPanelPresentationPort);
			await coordinator.handleConnectionState(true);
			await coordinator.handleConnectionState(false);
			reconnect = coordinator.handleConnectionState(true);
			await flushUntil(() => deps.ws.sendRequest.mock.calls.some(([request]) => 'type' in request && request.type === 'chat-subscribe'));
			await panels.loadChatSnapshot('chat-1');
			expect(cache.readAppliedCursor('chat-1')).toMatchObject({ stale: false, lastOrdinal: 1 });
			expect(panels.applyCommittedBatch({
				chatId: 'chat-1', transcriptViewId: 'generation-selected', messages: messages.slice(1),
				firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
			}).kind).toBe('applied');
			expect(cache.get('chat-1')?.messages).toEqual(messages.slice(0, 1));
			panels.prepareForReconcile([]);
			panels.reconcile([], presentation === 'retained' ? [descriptor] : []);
			if (presentation === 'retained') {
				expect(panels.panel(descriptor.surfaceId)).toBe(original);
				expect(original.isPresentationVisible).toBe(false);
				replay.reject(new Error('Replay interrupted'));
			} else {
				replay.resolve(deltaResponse('chat-1', 'generation-selected', []));
			}
			await reconnect;
			expect(cache.readAppliedCursor('chat-1')).toMatchObject({ stale: true, lastOrdinal: 1 });
			expect(panels.panel(descriptor.surfaceId)).toBeNull();
			expect(read).toHaveBeenCalledOnce();
			panels.reconcile([descriptor]);
			await panels.loadChatSnapshot('chat-1');
			expect(read).toHaveBeenCalledTimes(2);
			expect(cache.readAppliedCursor('chat-1')).toMatchObject({ stale: false, lastOrdinal: 2 });
			expect(panels.panel(descriptor.surfaceId)!.transcript.entries).toEqual(messages);
		} finally {
			await coordinator.handleConnectionState(false);
			panels.destroy();
			replay.resolve(deltaResponse('chat-1', 'generation-selected', []));
			await Promise.allSettled([reconnect]);
			read.mockRestore();
			cache.flush();
			localStorage.clear();
		}
	});

	it.each([true, false])('retries a rejected hidden snapshot after reconnect (revealed before rejection: %s)', async (revealBeforeRejection) => {
		localStorage.clear();
		const { cache, panels, descriptor, page } = snapshotRecoveryFixture(2);
		const held = deferred<CompleteChatHistoryResponse>();
		const read = vi.spyOn(chatsApi, 'getChatMessages').mockReturnValueOnce(held.promise).mockResolvedValue(page(2));
		cache.replaceFromPage('chat-1', page(1));
		try {
			panels.reconcile([descriptor]);
			const pending = panels.loadChatSnapshot('chat-1', { minimumLimit: 1 });
			panels.prepareForReconcile([]);
			panels.reconcile([]);
			const deps = createReconnectDeps();
			const coordinator = new ChatReconnectCoordinator({ ...deps, panels, getBackgroundCursors: () => [] });
			await coordinator.handleConnectionState(true);
			await coordinator.handleConnectionState(false);
			await coordinator.handleConnectionState(true);
			expect(cache.get('chat-1')?.stale).toBe(true);
			if (revealBeforeRejection) panels.reconcile([descriptor]);
			const revealed = revealBeforeRejection ? panels.loadChatSnapshot('chat-1') : null;
			held.reject(new Error('Hidden pre-reconnect read failed'));
			await Promise.all([pending, revealed]);
			if (!revealBeforeRejection) {
				expect(read).toHaveBeenCalledTimes(1);
				expect(cache.get('chat-1')?.stale).toBe(true);
				panels.reconcile([descriptor]);
				await panels.loadChatSnapshot('chat-1');
			}
			expect(read).toHaveBeenCalledTimes(2);
			expect(cache.get('chat-1')).toMatchObject({ stale: false, lastOrdinal: 2 });
			expect(panels.panel(descriptor.surfaceId)!.transcript.entries.map(entry => entry.ordinal)).toEqual([1, 2]);
		} finally {
			read.mockRestore();
			panels.destroy();
			cache.flush();
			localStorage.clear();
		}
	});

	it.each(['removed', 'fenced'] as const)('propagates a replacement snapshot failure after a %s loader rejects', async reason => {
		localStorage.clear();
		const { cache, panels, descriptor, page } = snapshotRecoveryFixture(1);
		const held = deferred<CompleteChatHistoryResponse>();
		const failure = new Error('Replacement snapshot failed');
		const read = vi.spyOn(chatsApi, 'getChatMessages').mockReturnValueOnce(held.promise).mockRejectedValue(failure);
		cache.replaceFromPage('chat-1', page(1));
		try {
			panels.reconcile([descriptor]);
			const pending = panels.loadChatSnapshot('chat-1', { minimumLimit: 1 });
			if (reason === 'removed') {
				panels.reconcile([]);
				cache.markStaleExcept(new Set());
				panels.reconcile([descriptor]);
			} else {
				panels.invalidateChatSnapshot('chat-1');
				panels.markChatStale('chat-1');
			}
			const revealed = panels.loadChatSnapshot('chat-1');
			const result = expect(Promise.all([pending, revealed])).rejects.toBe(failure);
			held.reject(new Error('Previous loader failed'));
			await result;
			expect(read).toHaveBeenCalledTimes(2);
			expect(cache.get('chat-1')?.stale).toBe(true);
			expect(panels.panel(descriptor.surfaceId)!.transcript.loadError).toBe(failure.message);
		} finally {
			read.mockRestore();
			panels.destroy();
			cache.flush();
			localStorage.clear();
		}
	});

	it('deduplicates snapshot recovery for duplicate rendered panels', async () => {
		const deps = createReconnectDeps();
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace(
			'chat-1',
			'generation-selected',
			[
				{ ordinal: 1, message: new AssistantMessage(TS, 'one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'two') },
			],
			2,
			null,
		);
		const lifecycle = new ConversationLifecycleState();
		lifecycle.setCurrentChatId('chat-1');
		const panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat: () => lifecycle,
				remove: vi.fn(),
			},
			getComposerAnchorSurfaceId: () => null,
			getSelectedChatId: () => null,
		});
		panels.reconcile([
			{
				surfaceId: 'chat-view:window-left',
				chatId: 'chat-1',
				snapshotAdmission: 'admitted',
				presentation: 'window-left',
				windowId: 'window-left',
			},
			{
				surfaceId: 'chat-view:window-right',
				chatId: 'chat-1',
				snapshotAdmission: 'admitted',
				presentation: 'window-right',
				windowId: 'window-right',
			},
		]);
		const loadChatSnapshot = vi.spyOn(panels, 'loadChatSnapshot').mockResolvedValue(true);
		const markValidated = vi.spyOn(cache, 'markValidated');
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });

		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		await coordinator.handleConnectionState(true);

		expect(loadChatSnapshot).toHaveBeenCalledOnce();
		expect(loadChatSnapshot).toHaveBeenCalledWith('chat-1');
		expect(markValidated).not.toHaveBeenCalled();
		panels.destroy();
		cache.flush();
	});

	it('[TLV5-REPLAY.05-WEB-UNIT-01] holds rendered live rows until a fixed reconnect replay completes', async () => {
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace(
			'chat-1',
			'generation-selected',
			[
				{ ordinal: 1, message: new AssistantMessage(TS, 'initial-one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'initial-two') },
			],
			2,
			null,
		);
		const lifecycle = new ConversationLifecycleState();
		lifecycle.setCurrentChatId('chat-1');
		const panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat: () => lifecycle,
				remove: vi.fn(),
			},
			getComposerAnchorSurfaceId: () => null,
			getSelectedChatId: () => null,
		});
		panels.reconcile([
			{
				surfaceId: 'chat-view:window-left',
				chatId: 'chat-1',
				snapshotAdmission: 'admitted',
				presentation: 'window-left',
				windowId: 'window-left',
			},
			{
				surfaceId: 'chat-view:window-right',
				chatId: 'chat-1',
				snapshotAdmission: 'admitted',
				presentation: 'window-right',
				windowId: 'window-right',
			},
		]);

		const heldContinuation = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps();
		let subscribeCount = 0;
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse([], ['chat-1']);
			}
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			subscribeCount += 1;
			if (subscribeCount === 1) {
				return boundedReplayResponse({
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 6,
					hasMore: true,
					messages: [messageJson(3, 'replay-three'), messageJson(4, 'replay-four')],
				});
			}
			if (subscribeCount === 2) return heldContinuation.promise;
			throw new Error('The coordinator requested beyond the fixed watermark.');
		});
		const loadChatSnapshot = vi.spyOn(panels, 'loadChatSnapshot');
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });

		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 2);

		expect(
			panels.applyCommittedBatch({
				chatId: 'chat-1',
				transcriptViewId: 'generation-selected',
				messages: [{ ordinal: 7, message: new AssistantMessage(TS, 'live-seven') }],
				firstOrdinal: 7,
				lastOrdinal: 7,
				resendCandidates: [],
				noticeRevision: 0,
			}),
		).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(4);

		heldContinuation.resolve(
			boundedReplayResponse({
				afterOrdinal: 4,
				nextAfterOrdinal: 6,
				throughOrdinal: 6,
				hasMore: false,
				messages: [messageJson(5, 'replay-five'), messageJson(6, 'replay-six')],
			}),
		);
		await reconnect;

		expect(loadChatSnapshot).not.toHaveBeenCalled();
		expect(cache.readAppliedCursor('chat-1')?.lastOrdinal).toBe(7);
		for (const surfaceId of ['chat-view:window-left', 'chat-view:window-right'] as const) {
			expect(
				panels
					.panel(surfaceId)
					?.transcript.entries.map((entry) =>
						'content' in entry.message ? entry.message.content : entry.message.type,
					),
			).toEqual([
				'initial-one',
				'initial-two',
				'replay-three',
				'replay-four',
				'replay-five',
				'replay-six',
				'live-seven',
			]);
		}
		panels.destroy();
		cache.flush();
	});

	it('keeps reconnect reconciliation resolved when a rendered snapshot load fails', async () => {
		const deps = createReconnectDeps();
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace(
			'chat-1',
			'generation-selected',
			[
				{ ordinal: 1, message: new AssistantMessage(TS, 'one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'two') },
			],
			2,
			null,
		);
		const lifecycle = new ConversationLifecycleState();
		lifecycle.setCurrentChatId('chat-1');
		const panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat: () => lifecycle,
				remove: vi.fn(),
			},
			getComposerAnchorSurfaceId: () => null,
			getSelectedChatId: () => null,
		});
		panels.reconcile([
			{
				surfaceId: 'chat-view:window-left',
				chatId: 'chat-1',
				snapshotAdmission: 'admitted',
				presentation: 'window-left',
				windowId: 'window-left',
			},
		]);
		vi.spyOn(panels, 'loadChatSnapshot').mockRejectedValue(new Error('snapshot unavailable'));
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });

		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		await expect(coordinator.handleConnectionState(true)).resolves.toBeUndefined();

		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(true);
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalled();
		panels.destroy();
		cache.flush();
	});

	it('confirms identified pongs and unregisters the authority consumer on cleanup', async () => {
		const deps = createReconnectDeps();
		deps.ws.isConnected = false;
		const view = render(ReconnectCoordinatorTestHost, { options: deps });
		await vi.waitFor(() => expect(deps.ws.addMessageConsumer).toHaveBeenCalledOnce());
		deps.conversationUi.confirmExecutionControlSocketInstance.mockClear();
		const consumer = deps.ws.addMessageConsumer.mock.calls[0]?.[0];
		if (!consumer) throw new Error('Reconnect authority consumer was not registered.');
		expect(
			consumer(
				{
					type: 'ws-pong',
					clientRequestId: 'probe-malformed',
					sentAt: 1,
					serverTime: TS,
					processing: { outcome: 'snapshot', chats: [] },
				},
				{},
			),
		).toBe(false);
		expect(deps.conversationUi.confirmExecutionControlSocketInstance).not.toHaveBeenCalled();

		expect(
			consumer(
				{
					type: 'ws-pong',
					clientRequestId: 'probe-1',
					sentAt: 1,
					serverTime: TS,
					serverInstanceId: 'server-b',
					processing: { outcome: 'snapshot', chats: [] },
				},
				{},
			),
		).toBe(false);
		expect(deps.conversationUi.confirmExecutionControlSocketInstance).toHaveBeenCalledWith(
			'server-b',
		);

		const removeConsumer = deps.ws.addMessageConsumer.mock.results[0]?.value;
		view.unmount();
		expect(removeConsumer).toHaveBeenCalledOnce();
	});

	it('lets a correlated pong replace provisional controls with the current socket instance', async () => {
		const conversationUi = new ConversationUiState();
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-b'));
		const deps = createReconnectDeps();
		deps.ws.isConnected = false;
		const view = render(ReconnectCoordinatorTestHost, {
			options: { ...deps, conversationUi },
		});
		await vi.waitFor(() => expect(deps.ws.addMessageConsumer).toHaveBeenCalledOnce());
		const consumer = deps.ws.addMessageConsumer.mock.calls[0]?.[0];
		if (!consumer) throw new Error('Reconnect authority consumer was not registered.');

		consumer(
			{
				type: 'ws-pong',
				clientRequestId: 'probe-1',
				sentAt: 1,
				serverTime: TS,
				serverInstanceId: 'server-c',
				processing: { outcome: 'snapshot', chats: [] },
			},
			{},
		);

		expect(conversationUi.getExecutionControl('chat-1')).toBeNull();
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(false, 'server-c'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-d'));
		expect(conversationUi.getExecutionControl('chat-1')).toEqual(controlState(false, 'server-c'));
		warn.mockRestore();
		view.unmount();
	});

	it('reconciles control state without transcript replay on first connection', async () => {
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		const coordinator = new ChatReconnectCoordinator(deps);

		await coordinator.handleConnectionState(true);

		expect(deps.ws.sendRequest).toHaveBeenCalledOnce();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
		);
		expect(deps.conversationUi.confirmExecutionControlSocketInstance).toHaveBeenCalledWith(
			'server-instance-test',
		);
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(deps.ws.sendRequest).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'chat-subscribe' }),
		);
	});

	it('keeps reconnect control-state reconciliation usable when chat-list refresh fails', async () => {
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		deps.sessions.quietRefreshChats.mockRejectedValue(new Error('chat list unavailable'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const coordinator = new ChatReconnectCoordinator(deps);

			await expect(coordinator.handleConnectionState(true)).resolves.toBeUndefined();

			expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
				'chat-1',
				controlState(false),
			);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('does not reject background resume when its follow-up chat-list refresh fails', async () => {
		const deps = createReconnectDeps({
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 2 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.sessions.quietRefreshChats.mockRejectedValue(new Error('chat list unavailable'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			await expect(reconnectAfterFirstConnection(deps)).resolves.toBeUndefined();

			expect(deps.onBackgroundMessages).toHaveBeenCalledWith(
				'chat-2',
				'generation-2',
				expect.any(Array),
				3,
				3,
			);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('applies background replay through a parked transcript window', async () => {
		const deps = createReconnectDeps({
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 2 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.panels.hasInactiveWindow.mockImplementation((chatId: string) => chatId === 'chat-2');

		await reconnectAfterFirstConnection(deps);

		expect(deps.panels.applyReconnectReplayPage).toHaveBeenCalledWith(
			expect.any(Number),
			'chat-2',
			expect.objectContaining({
				transcriptViewId: 'generation-2', firstOrdinal: 3, lastOrdinal: 3,
			}),
		);
		expect(deps.panels.finishReconnectReplay).toHaveBeenCalledWith(expect.any(Number), 'chat-2');
		expect(deps.onBackgroundMessages).not.toHaveBeenCalled();
	});

	it('protects every parked background chat before awaiting the first replay', async () => {
		const heldFirstReplay = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({
			backgroundCursors: [
				{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 2 },
				{ chatId: 'chat-3', transcriptViewId: 'generation-3', lastOrdinal: 2 },
			],
			subscribeResponses: {
				'chat-3': deltaResponse('chat-3', 'generation-3', [messageJson(3, 'later-three')]),
			},
		});
		deps.panels.hasInactiveWindow.mockReturnValue(true);
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') return reconnectStateResponse();
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			if (request.chatId === 'chat-2') return heldFirstReplay.promise;
			return deltaResponse('chat-3', 'generation-3', [messageJson(3, 'later-three')]);
		});
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await vi.waitFor(() => {
			expect(deps.panels.beginReconnectReplay).toHaveBeenCalledWith('chat-2', 'generation-2');
			expect(deps.panels.beginReconnectReplay).toHaveBeenCalledWith('chat-3', 'generation-3');
		});
		heldFirstReplay.resolve(deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later-two')]));
		await reconnect;
	});

	it('reconciles running sessions, refreshes chats, and resumes the selected chat', async () => {
		const deps = createReconnectDeps({
			runningIds: ['chat-1'],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'missed')]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.sessions.quietRefreshChats).toHaveBeenCalled();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
		);
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'chat-subscribe',
				chatId: 'chat-1',
				transcriptViewId: 'generation-selected',
				afterOrdinal: 2,
			}),
		);
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ ordinal: 3 })]),
			3,
			3,
		);
	});

	it('resumes the selected chat without waiting for control-state reconciliation', async () => {
		const controlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return controlState.promise;
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'missed')]);
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await flushUntil(() => deps.chatState.transcriptCache.markValidated.mock.calls.length === 1);
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ ordinal: 3 })]),
			3,
			3,
		);

		controlState.resolve(reconnectStateResponse([], ['chat-1']));
		await reconnect;
	});

	it('completes global reconciliation while the selected resume is pending', async () => {
		const selectedSubscribe = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse(['chat-1'], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') return selectedSubscribe.promise;
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await flushUntil(
			() =>
				deps.conversationUi.setExecutionControlFromRefresh.mock.calls.length === 1 &&
				deps.sessions.quietRefreshChats.mock.calls.length === 1,
		);
		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
		expect(deps.getExecutionControl).not.toHaveBeenCalled();

		selectedSubscribe.resolve(deltaResponse('chat-1'));
		await reconnect;
	});

	it('refreshes the selected queue even when the chat is idle', async () => {
		const deps = createReconnectDeps({ runningIds: [] });

		await reconnectAfterFirstConnection(deps);

		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1'],
		});
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
	});

	it('refreshes cached background queues after reconnect', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-1', 'chat-2', 'chat-3'],
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			controlChatIds: ['chat-1', 'chat-2', 'chat-3'],
		});
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(3);
		expect(deps.getExecutionControl).not.toHaveBeenCalled();
	});

	it('falls back to HTTP only for a reconnect snapshot omitted by the server', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-1', 'chat-2'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.getExecutionControl).toHaveBeenCalledTimes(1);
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(false),
		);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-2',
			controlState(false),
		);
	});

	it('applies explicit reconnect queue outcomes without treating deletion as an outage', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2', 'chat-3'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return {
						type: 'reconnect-state',
						clientRequestId: 'req-reconnect',
						serverInstanceId: 'server-instance-test',
						processing: { outcome: 'snapshot', chats: [] },
						controlResults: [
							{ chatId: 'chat-1', outcome: 'snapshot', control: controlState(true) },
							{ chatId: 'chat-2', outcome: 'not-found' },
							{ chatId: 'chat-3', outcome: 'unavailable' },
							{ chatId: 'not-requested', outcome: 'snapshot', control: controlState(true) },
						],
					};
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		expect(deps.conversationUi.removeExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.getExecutionControl).toHaveBeenCalledTimes(1);
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-3');
		expect(deps.conversationUi.setExecutionControlFromRefresh).not.toHaveBeenCalledWith(
			'not-requested',
			expect.anything(),
		);
	});

	it('applies queue outcomes when processing is unavailable', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2', 'chat-3'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return {
						type: 'reconnect-state',
						clientRequestId: 'req-reconnect',
						serverInstanceId: 'server-instance-test',
						processing: { outcome: 'unavailable' },
						controlResults: [
							{ chatId: 'chat-1', outcome: 'snapshot', control: controlState(true) },
							{ chatId: 'chat-2', outcome: 'not-found' },
							{ chatId: 'chat-3', outcome: 'unavailable' },
						],
					};
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		expect(deps.conversationUi.removeExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.getExecutionControl).toHaveBeenCalledOnce();
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-3');
	});

	it('refreshes chats and controls when the reconnect-state request fails', async () => {
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);

		await coordinator.handleConnectionState(false);
		expect(deps.conversationUi.markExecutionControlSocketDisconnected).toHaveBeenCalledOnce();
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if (!('type' in request)) throw new Error('Request is missing a type');
			if (request.type === 'reconnect-state-query') {
				throw new Error('reconnect state unavailable');
			}
			if (request.type === 'chat-subscribe') return deltaResponse('chat-1');
			throw new Error(`Unexpected request: ${String(request.type)}`);
		});
		await coordinator.handleConnectionState(true);

		expect(deps.sessions.quietRefreshChats).toHaveBeenCalledOnce();
	});

	it('lets fallback C clear provisional B after the reconnect envelope fails', async () => {
		const conversationUi = new ConversationUiState();
		conversationUi.confirmExecutionControlSocketInstance('server-a');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-a'));
		const deps = createReconnectDeps();
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if ('type' in request && request.type === 'reconnect-state-query') {
				throw new Error('reconnect state unavailable');
			}
			throw new Error('Unexpected request');
		});
		deps.getExecutionControl.mockResolvedValue({
			control: controlState(false, 'server-c'),
		});
		const coordinator = new ChatReconnectCoordinator({ ...deps, conversationUi });

		await coordinator.handleConnectionState(false);
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-b'));
		await coordinator.handleConnectionState(true);

		expect(conversationUi.getExecutionControl('chat-1')).toEqual(controlState(false, 'server-c'));
	});

	it('does not apply fallback results that straddle a newer socket epoch', async () => {
		const firstFallback = deferred<{ control: ChatExecutionControlState }>();
		const conversationUi = new ConversationUiState();
		conversationUi.confirmExecutionControlSocketInstance('server-a');
		conversationUi.setExecutionControlFromLiveUpdate('chat-1', controlState(true, 'server-a'));
		const deps = createReconnectDeps();
		deps.ws.sendRequest.mockRejectedValue(new Error('reconnect state unavailable'));
		deps.getExecutionControl
			.mockImplementationOnce(() => firstFallback.promise)
			.mockResolvedValueOnce({ control: controlState(false, 'server-c') });
		const coordinator = new ChatReconnectCoordinator({ ...deps, conversationUi });

		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => deps.getExecutionControl.mock.calls.length === 1);
		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);
		await second;
		firstFallback.resolve({ control: controlState(true, 'server-b') });
		await first;

		expect(conversationUi.getExecutionControl('chat-1')).toEqual(controlState(false, 'server-c'));
	});

	it('falls back queue reads but preserves processing state when reconnect control data is malformed', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return {
						type: 'reconnect-state',
						serverInstanceId: 'server-instance-test',
						processing: {
							outcome: 'snapshot',
							chats: [{ chatId: 42, phase: 'running' }],
						},
						controlResults: [
							{ chatId: 'chat-1', outcome: 'snapshot', control: controlState(true) },
							{ chatId: 'chat-2', outcome: 'snapshot', control: controlState(true) },
						],
					};
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-1');
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-2');
		expect(deps.conversationUi.setExecutionControlFromRefresh).not.toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
	});

	it('falls back without confirming a mixed-instance reconnect envelope', async () => {
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		deps.conversationUi.confirmExecutionControlSocketInstance.mockClear();
		deps.ws.sendRequest.mockImplementation(async (request: object) => {
			if (!('type' in request)) throw new Error('Request is missing a type');
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse(
					[],
					['chat-1'],
					{ 'chat-1': controlState(true, 'server-a') },
					'server-b',
				);
			}
			if (request.type === 'chat-subscribe') return deltaResponse('chat-1');
			throw new Error(`Unexpected request: ${String(request.type)}`);
		});

		await coordinator.handleConnectionState(true);

		expect(deps.conversationUi.confirmExecutionControlSocketInstance).not.toHaveBeenCalled();
		expect(deps.getExecutionControl).toHaveBeenCalledWith('chat-1');
	});

	it('does not block transcript resume on the reconnect control-state request', async () => {
		const heldControlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			controlChatIds: ['chat-2'],
			backgroundCursors: [{ chatId: 'chat-4', transcriptViewId: 'generation-4', lastOrdinal: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-4': deltaResponse('chat-4', 'generation-4', [messageJson(2, 'background')]),
			},
		});
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return heldControlState.promise;
				if (request.type === 'chat-subscribe') {
					const chatId = String(request.chatId ?? '');
					return chatId === 'chat-4'
						? deltaResponse(chatId, `generation-${chatId.slice(-1)}`, [messageJson(2, chatId)])
						: deltaResponse(chatId, 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await coordinator.handleConnectionState(false);
		let reconnectSettled = false;
		const reconnect = coordinator.handleConnectionState(true).then(() => {
			reconnectSettled = true;
		});

		await flushUntil(
			() =>
				deps.onBackgroundMessages.mock.calls.length === 1 &&
				deps.chatState.transcriptCache.markValidated.mock.calls.length === 2,
		);
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
		expect(reconnectSettled).toBe(false);

		heldControlState.resolve(reconnectStateResponse([], ['chat-1', 'chat-2']));
		await reconnect;
	});

	it('falls back to selected snapshot on snapshot-required subscribe response', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': snapshotRequiredResponse('chat-1', null),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).not.toHaveBeenCalled();
	});

	it('falls back to selected snapshot when reconnect replay detects a seq gap', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [messageJson(5, 'later')]),
			},
		});
		(deps.chatState.applyMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce('gap-detected');

		await reconnectAfterFirstConnection(deps);

		expect(deps.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).not.toHaveBeenCalled();
	});

	it('advances selected coverage through hidden reconnect rows without loading a snapshot', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': {
					...deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'partial')]),
					lastOrdinal: 4,
					nextAfterOrdinal: 4,
					throughOrdinal: 4,
					hasMore: false,
				},
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.panels.loadChatSnapshot).not.toHaveBeenCalled();
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('applies bounded replay pages in order before validating the selected transcript', async () => {
		const pages = [
			boundedReplayResponse({
				afterOrdinal: 2,
				nextAfterOrdinal: 4,
				throughOrdinal: 7,
				hasMore: true,
				messages: [messageJson(3, 'page-one')],
			}),
			boundedReplayResponse({
				afterOrdinal: 4,
				nextAfterOrdinal: 6,
				throughOrdinal: 7,
				hasMore: true,
			}),
			boundedReplayResponse({
				afterOrdinal: 6,
				nextAfterOrdinal: 7,
				throughOrdinal: 7,
				hasMore: false,
				messages: [messageJson(7, 'page-three')],
			}),
		];
		const deps = createReconnectDeps();
		let pageIndex = 0;
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') {
					if (pageIndex > 0) {
						expect(deps.chatState.applyMessages).toHaveBeenCalledTimes(pageIndex);
					}
					const response = pages[pageIndex];
					if (!response) throw new Error('The coordinator requested beyond the fixed watermark.');
					pageIndex += 1;
					return response;
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		const subscribeRequests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe');
		expect(subscribeRequests).toHaveLength(3);
		expect(subscribeRequests[0]).toMatchObject({
			chatId: 'chat-1',
			transcriptViewId: 'generation-selected',
			afterOrdinal: 2,
		});
		expect(subscribeRequests[0]).not.toHaveProperty('throughOrdinal');
		expect(subscribeRequests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 7 });
		expect(subscribeRequests[2]).toMatchObject({ afterOrdinal: 6, throughOrdinal: 7 });
		expect(
			deps.chatState.applyMessages.mock.calls.map((call) => ({
				messages: call[2].map((entry) => entry.ordinal),
				firstOrdinal: call[3],
				lastOrdinal: call[4],
			})),
		).toEqual([
			{ messages: [3], firstOrdinal: 3, lastOrdinal: 4 },
			{ messages: [], firstOrdinal: 5, lastOrdinal: 6 },
			{ messages: [7], firstOrdinal: 7, lastOrdinal: 7 },
		]);
		expect(deps.panels.loadChatSnapshot).not.toHaveBeenCalled();
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledOnce();
	});

	it('rejects a continuation that changes the captured replay watermark', async () => {
		const deps = createReconnectDeps();
		let pageIndex = 0;
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse([], ['chat-1']);
			}
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			pageIndex += 1;
			if (pageIndex === 1) {
				return boundedReplayResponse({
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 6,
					hasMore: true,
					messages: [messageJson(3, 'stable-page')],
				});
			}
			if (pageIndex === 2) {
				return boundedReplayResponse({
					afterOrdinal: 4,
					nextAfterOrdinal: 7,
					throughOrdinal: 7,
					hasMore: false,
					messages: [messageJson(7, 'foreign-watermark-page')],
				});
			}
			throw new Error('The coordinator requested beyond the malformed continuation.');
		});

		await reconnectAfterFirstConnection(deps);

		expect(pageIndex).toBe(2);
		expect(deps.chatState.applyMessages).toHaveBeenCalledOnce();
		expect(deps.chatState.applyMessages.mock.calls[0]?.[2]).toEqual([
			expect.objectContaining({ ordinal: 3 }),
		]);
		expect(deps.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-1');
	});

	it('[TLV5-REPLAY.07-WEB-UNIT-01] discards a partial rendered replay when its transcript view is replaced', async () => {
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace(
			'chat-1',
			'generation-selected',
			[
				{ ordinal: 1, message: new AssistantMessage(TS, 'old-one') },
				{ ordinal: 2, message: new AssistantMessage(TS, 'old-two') },
			],
			2,
			null,
		);
		const lifecycle = new ConversationLifecycleState();
		lifecycle.setCurrentChatId('chat-1');
		const panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat: () => lifecycle,
				remove: vi.fn(),
			},
			getComposerAnchorSurfaceId: () => null,
			getSelectedChatId: () => null,
		});
		panels.reconcile([
			{
				surfaceId: 'chat-view:window-left',
				chatId: 'chat-1',
				snapshotAdmission: 'admitted',
				presentation: 'window-left',
				windowId: 'window-left',
			},
		]);
		const activeTranscript = panels.panel('chat-view:window-left')?.transcript;
		if (!activeTranscript) throw new Error('Expected a rendered conversation panel.');
		const heldContinuation = deferred<Record<string, unknown>>();
		const baseDeps = createReconnectDeps();
		let subscribeCount = 0;
		baseDeps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') {
				return reconnectStateResponse([], ['chat-1']);
			}
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			subscribeCount += 1;
			if (subscribeCount === 1) {
				return boundedReplayResponse({
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 6,
					hasMore: true,
					messages: [messageJson(3, 'old-three'), messageJson(4, 'old-four')],
				});
			}
			if (subscribeCount === 2) return heldContinuation.promise;
			throw new Error('The coordinator requested beyond the replaced transcript view.');
		});
		const loadChatSnapshot = vi.spyOn(panels, 'loadChatSnapshot').mockResolvedValue(true);
		const markValidated = vi.spyOn(cache, 'markValidated');
		const deps = { ...baseDeps, panels } satisfies ChatReconnectCoordinatorOptions;
		const coordinator = new ChatReconnectCoordinator(deps);

		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 2);

		activeTranscript.replaceGeneration(
			'chat-1',
			'generation-reloaded',
			[{ ordinal: 1, message: new AssistantMessage(TS, 'reloaded-one') }],
			{
				lastOrdinal: 1,
				pageOldestOrdinal: 1,
				pageNewestOrdinal: 1,
				nextBeforeOrdinal: null,
				hasMore: false,
			},
		);
		expect(
			panels.applyCommittedBatch({
				chatId: 'chat-1',
				transcriptViewId: 'generation-reloaded',
				messages: [{ ordinal: 2, message: new AssistantMessage(TS, 'reloaded-live-two') }],
				firstOrdinal: 2,
				lastOrdinal: 2,
				resendCandidates: [],
				noticeRevision: 0,
			}),
		).toEqual({ kind: 'applied', localRecoverySurfaceIds: [] });
		baseDeps.conversationUi.setTransientFeedFromSnapshot.mockClear();
		heldContinuation.resolve(
			boundedReplayResponse({
				afterOrdinal: 4,
				nextAfterOrdinal: 6,
				throughOrdinal: 6,
				hasMore: false,
				messages: [messageJson(5, 'old-five'), messageJson(6, 'old-six')],
			}),
		);
		await reconnect;

		expect(loadChatSnapshot).toHaveBeenCalledOnce();
		expect(loadChatSnapshot).toHaveBeenCalledWith('chat-1');
		expect(markValidated).not.toHaveBeenCalled();
		expect(baseDeps.conversationUi.setTransientFeedFromSnapshot).not.toHaveBeenCalled();
		expect(
			activeTranscript.entries.map((entry) => ({
				ordinal: entry.ordinal,
				content: 'content' in entry.message ? entry.message.content : entry.message.type,
			})),
		).toEqual([
			{ ordinal: 1, content: 'reloaded-one' },
			{ ordinal: 2, content: 'reloaded-live-two' },
		]);
		expect(activeTranscript.getCursor()).toEqual({
			transcriptViewId: 'generation-reloaded',
			lastOrdinal: 2,
		});
		panels.destroy();
		cache.flush();
	});

	it('applies every bounded replay page to a cached background transcript', async () => {
		const deps = createReconnectDeps({
			selectedChatId: '',
			backgroundCursors: [
				{
					chatId: 'chat-background',
					transcriptViewId: 'generation-background',
					lastOrdinal: 2,
				},
			],
		});
		let backgroundPage = 0;
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') return reconnectStateResponse();
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			backgroundPage += 1;
			if (backgroundPage === 1) {
				return boundedReplayResponse({
					chatId: 'chat-background',
					transcriptViewId: 'generation-background',
					afterOrdinal: 2,
					nextAfterOrdinal: 4,
					throughOrdinal: 5,
					hasMore: true,
				});
			}
			if (backgroundPage === 2) {
				expect(deps.onBackgroundMessages).toHaveBeenCalledOnce();
				return boundedReplayResponse({
					chatId: 'chat-background',
					transcriptViewId: 'generation-background',
					afterOrdinal: 4,
					nextAfterOrdinal: 5,
					throughOrdinal: 5,
					hasMore: false,
					messages: [messageJson(5, 'background-five')],
				});
			}
			throw new Error('The background replay requested beyond the fixed watermark.');
		});

		await reconnectAfterFirstConnection(deps);

		const requests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter(
				(request) => request.type === 'chat-subscribe' && request.chatId === 'chat-background',
			);
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({ afterOrdinal: 2 });
		expect(requests[0]).not.toHaveProperty('throughOrdinal');
		expect(requests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 5 });
		expect(
			deps.onBackgroundMessages.mock.calls.map((call) => ({
				ordinals: call[2].map((entry: TranscriptMessage) => entry.ordinal),
				firstOrdinal: call[3],
				lastOrdinal: call[4],
			})),
		).toEqual([
			{ ordinals: [], firstOrdinal: 3, lastOrdinal: 4 },
			{ ordinals: [5], firstOrdinal: 5, lastOrdinal: 5 },
		]);
		expect(deps.markBackgroundStale).not.toHaveBeenCalled();
	});

	it('fans out a background replay page when its panel mounts during reconnect', async () => {
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace(
			'chat-background',
			'generation-background',
			[{ ordinal: 1, message: new AssistantMessage(TS, 'background-one') }],
			1,
			null,
		);
		const lifecycle = new ConversationLifecycleState();
		lifecycle.setCurrentChatId('chat-background');
		const panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat: () => lifecycle,
				remove: vi.fn(),
			},
			getComposerAnchorSurfaceId: () => null,
			getSelectedChatId: () => null,
		});
		const deps = createReconnectDeps({
			selectedChatId: '',
			backgroundCursors: [
				{
					chatId: 'chat-background',
					transcriptViewId: 'generation-background',
					lastOrdinal: 1,
				},
			],
		});
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') return reconnectStateResponse();
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			panels.reconcile([
				{
					surfaceId: 'chat-view:window-background',
					chatId: 'chat-background',
					snapshotAdmission: 'admitted',
					presentation: 'window-background',
					windowId: 'window-background',
				},
			]);
			return deltaResponse('chat-background', 'generation-background', [
				messageJson(2, 'background-two'),
			]);
		});

		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		await coordinator.handleConnectionState(true);
		expect(deps.onBackgroundMessages).not.toHaveBeenCalled();
		expect(
			panels.panel('chat-view:window-background')?.transcript.entries.map((entry) => entry.ordinal),
		).toEqual([1, 2]);
		panels.destroy();
		cache.flush();
	});

	it.each([
		{ initial: 'cache-only', order: 'snapshot-first', expectedReads: 1 },
		{ initial: 'cache-only', order: 'replay-first', expectedReads: 1 },
		{ initial: 'retained', order: 'snapshot-first', expectedReads: 1 },
		{ initial: 'retained', order: 'replay-first', expectedReads: 1 },
		{ initial: 'retained', order: 'before-reveal', expectedReads: 0 },
		{ initial: 'retained', order: 'rejected', expectedReads: 2 },
	] as const)('reveals a $initial background chat during recovery ($order)', async ({ initial, order, expectedReads }) => {
		localStorage.clear();
		const { cache, panels, descriptor, messages, page } = snapshotRecoveryFixture(3);
		cache.replaceFromPage('chat-1', page(1));
		const snapshot = deferred<CompleteChatHistoryResponse>();
		const replay = deferred<Record<string, unknown>>();
		const read = vi.spyOn(chatsApi, 'getChatMessages')
			.mockReturnValueOnce(snapshot.promise).mockResolvedValue(page(2));
		const deps = createReconnectDeps({ selectedChatId: '' });
		deps.getBackgroundCursors.mockImplementation(limit => cache.listCursors(limit));
		deps.markBackgroundStale.mockImplementation(chatId => panels.markChatStale(chatId));
		deps.ws.sendRequest.mockImplementation(async request => {
			if ('type' in request && request.type === 'chat-subscribe') return replay.promise;
			return reconnectStateResponse();
		});
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });
		let reconnect: Promise<void> | undefined;
		let load: Promise<boolean> | undefined;
		const replayPage = deltaResponse('chat-1', 'generation-selected', [messageJson(2, 'row-2')]);
		try {
			if (initial === 'retained') panels.reconcile([descriptor]);
			const original = panels.panel(descriptor.surfaceId);
			original?.attachPresentation({
				getScrollContainer: () => null, getViewport: () => null, getQueueContainer: () => undefined,
				captureRestoreTarget: () => ({ kind: 'end' }), closeTransients: () => {}, prepareForHide: () => {},
			} satisfies ConversationPanelPresentationPort);
			await coordinator.handleConnectionState(true);
			await coordinator.handleConnectionState(false);
			panels.prepareForReconcile([]);
			panels.reconcile([], initial === 'retained' ? [descriptor] : []);
			reconnect = coordinator.handleConnectionState(true);
			await flushUntil(() => deps.ws.sendRequest.mock.calls.some(([request]) => 'type' in request && request.type === 'chat-subscribe'));
			expect(panels.panel(descriptor.surfaceId)).toBe(original);
			if (original) expect(original.isPresentationVisible).toBe(false);
			expect(cache.get('chat-1')?.stale).toBe(true);
			expect(read).not.toHaveBeenCalled();
			if (order === 'before-reveal') {
				replay.resolve(replayPage);
				await reconnect;
				expect(cache.readAppliedCursor('chat-1')).toMatchObject({ stale: false, lastOrdinal: 2 });
			}
			panels.prepareForReconcile([descriptor]);
			panels.reconcile([descriptor]);
			if (order === 'before-reveal') {
				expect(panels.panel(descriptor.surfaceId)).toBe(original);
			} else {
				expect(panels.panel(descriptor.surfaceId)).not.toBe(original);
				load = panels.loadChatSnapshot('chat-1');
				expect(read).toHaveBeenCalledOnce();
			}
			expect(panels.applyCommittedBatch({
				chatId: 'chat-1', transcriptViewId: 'generation-selected', messages: messages.slice(1, 2),
				firstOrdinal: 2, lastOrdinal: 2, resendCandidates: [], noticeRevision: 0,
			}).kind).toBe('applied');
			expect(cache.get('chat-1')?.stale).toBe(order !== 'before-reveal');
			if (order === 'snapshot-first') {
				snapshot.resolve(page(2));
				await load;
				replay.resolve(replayPage);
			} else if (order === 'replay-first') {
				replay.resolve(replayPage);
				await reconnect;
				snapshot.resolve(page(2));
			} else if (order === 'rejected') {
				replay.reject(new Error('Replay interrupted'));
				await flushUntil(() => deps.markBackgroundStale.mock.calls.length === 1);
				expect(cache.get('chat-1')?.stale).toBe(true);
				snapshot.resolve(page(2));
			}
			await Promise.all([reconnect, load]);
			expect(panels.applyCommittedBatch({
				chatId: 'chat-1', transcriptViewId: 'generation-selected', messages: messages.slice(2),
				firstOrdinal: 3, lastOrdinal: 3, resendCandidates: [], noticeRevision: 0,
			}).kind).toBe('applied');
			expect(read).toHaveBeenCalledTimes(expectedReads);
			expect(deps.onBackgroundMessages).not.toHaveBeenCalled();
			expect(cache.readAppliedCursor('chat-1')).toMatchObject({ stale: false, lastOrdinal: 3 });
			expect(cache.get('chat-1')?.messages).toEqual(messages);
			expect(panels.panel(descriptor.surfaceId)!.transcript.entries).toEqual(messages);
		} finally {
			await coordinator.handleConnectionState(false);
			panels.destroy();
			snapshot.resolve(page(2));
			replay.resolve(replayPage);
			await Promise.allSettled([reconnect, load]);
			read.mockRestore();
			cache.flush();
			localStorage.clear();
		}
	});

	it('buffers live events behind replay for a parked transcript window', async () => {
		const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 60_000 });
		cache.replace(
			'chat-background',
			'generation-background',
			[{ ordinal: 1, message: new AssistantMessage(TS, 'background-one') }],
			1,
			null,
		);
		cache.replace(
			'chat-other',
			'generation-other',
			[{ ordinal: 1, message: new AssistantMessage(TS, 'other-one') }],
			1,
			null,
		);
		const lifecycle = new ConversationLifecycleState();
		const panels = new ConversationPanelRegistry({
			cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: {
				forChat: (chatId) => {
					lifecycle.setCurrentChatId(chatId);
					return lifecycle;
				},
				remove: vi.fn(),
			},
			getComposerAnchorSurfaceId: () => null,
			getSelectedChatId: () => null,
			retainInactiveWindows: () => true,
		});
		panels.reconcile([{
			surfaceId: 'chat-view:window-background', chatId: 'chat-background',
			snapshotAdmission: 'admitted', presentation: 'window-background', windowId: 'window-background',
		}]);
		panels.prepareForReconcile([{
			surfaceId: 'chat-view:window-background', chatId: 'chat-other',
			snapshotAdmission: 'admitted', presentation: 'window-background', windowId: 'window-background',
		}]);
		panels.reconcile([{
			surfaceId: 'chat-view:window-background', chatId: 'chat-other',
			snapshotAdmission: 'admitted', presentation: 'window-background', windowId: 'window-background',
		}]);
		expect(panels.hasInactiveWindow('chat-background')).toBe(true);
		const deps = createReconnectDeps({
			selectedChatId: '',
			backgroundCursors: [{
				chatId: 'chat-background', transcriptViewId: 'generation-background', lastOrdinal: 1,
			}],
		});
		deps.ws.sendRequest.mockImplementation(async (rawRequest: object) => {
			const request = rawRequest as Record<string, unknown>;
			if (request.type === 'reconnect-state-query') return reconnectStateResponse();
			if (request.type !== 'chat-subscribe') {
				throw new Error(`Unexpected request: ${String(request.type)}`);
			}
			if (request.chatId === 'chat-other') {
				return deltaResponse('chat-other', 'generation-other', [], 1);
			}
			panels.applyCommittedBatch({
				chatId: 'chat-background', transcriptViewId: 'generation-background',
				messages: [{ ordinal: 3, message: new AssistantMessage(TS, 'background-three') }],
				firstOrdinal: 3, lastOrdinal: 3, resendCandidates: [], noticeRevision: 0,
			});
			return deltaResponse('chat-background', 'generation-background', [
				messageJson(2, 'background-two'),
			]);
		});
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels });
		await coordinator.handleConnectionState(true);
		expect(panels.hasInactiveWindow('chat-background')).toBe(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		expect(panels.hasInactiveWindow('chat-background')).toBe(true);
		await coordinator.handleConnectionState(true);
		expect(cache.readAppliedCursor('chat-background')).toMatchObject({ lastOrdinal: 3, stale: false });
		expect(panels.hasInactiveWindow('chat-background')).toBe(true);
		panels.prepareForReconcile([{
			surfaceId: 'chat-view:window-background', chatId: 'chat-background',
			snapshotAdmission: 'admitted', presentation: 'window-background', windowId: 'window-background',
		}]);
		panels.reconcile([{
			surfaceId: 'chat-view:window-background', chatId: 'chat-background',
			snapshotAdmission: 'admitted', presentation: 'window-background', windowId: 'window-background',
		}]);

		expect(
			panels.panel('chat-view:window-background')?.transcript.entries.map((entry) => entry.ordinal),
		).toEqual([1, 2, 3]);
		expect(deps.onBackgroundMessages).not.toHaveBeenCalled();
		panels.destroy();
		cache.flush();
	});

	it('[TLV5-REPLAY.06-WEB-UNIT-01] abandons a partial replay on disconnect and restarts with a fresh watermark', async () => {
		const heldContinuation = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps();
		let subscribeCount = 0;
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type !== 'chat-subscribe') {
					throw new Error(`Unexpected request: ${String(request.type)}`);
				}
				subscribeCount += 1;
				if (subscribeCount === 1) {
					return boundedReplayResponse({
						afterOrdinal: 2,
						nextAfterOrdinal: 4,
						throughOrdinal: 6,
						hasMore: true,
						messages: [messageJson(3, 'old-page-one')],
					});
				}
				if (subscribeCount === 2) return heldContinuation.promise;
				if (subscribeCount === 3) {
					return boundedReplayResponse({
						afterOrdinal: 4,
						nextAfterOrdinal: 8,
						throughOrdinal: 8,
						hasMore: false,
						messages: [messageJson(5, 'fresh-page'), messageJson(8, 'fresh-live-tail')],
					});
				}
				throw new Error('The coordinator requested an unexpected replay page.');
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		await coordinator.handleConnectionState(false);
		expect(deps.panels.discardFullscreenHiddenPanels).toHaveBeenCalledOnce();
		const interruptedReplay = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 2);
		expect(deps.chatState.transcriptCache.markValidated).not.toHaveBeenCalled();

		await coordinator.handleConnectionState(false);
		const restartedReplay = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 3);
		await restartedReplay;

		heldContinuation.resolve(
			boundedReplayResponse({
				afterOrdinal: 4,
				nextAfterOrdinal: 6,
				throughOrdinal: 6,
				hasMore: false,
				messages: [messageJson(6, 'stale-page')],
			}),
		);
		await interruptedReplay;

		const subscribeRequests = deps.ws.sendRequest.mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe');
		expect(subscribeRequests).toHaveLength(3);
		expect(subscribeRequests[1]).toMatchObject({ afterOrdinal: 4, throughOrdinal: 6 });
		expect(subscribeRequests[2]).toMatchObject({ afterOrdinal: 4 });
		expect(subscribeRequests[2]).not.toHaveProperty('throughOrdinal');
		expect(
			deps.chatState.applyMessages.mock.calls.flatMap((call) =>
				call[2].map((entry) =>
					entry.message.type === 'assistant-message' ? entry.message.content : entry.message.type,
				),
			),
		).toEqual(['old-page-one', 'fresh-page', 'fresh-live-tail']);
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledOnce();
	});

	it('falls back to selected snapshot when subscribe request fails', async () => {
		const deps = createReconnectDeps();
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') throw new Error('network down');
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).not.toHaveBeenCalled();
		expect(deps.chatState.applyMessages).not.toHaveBeenCalled();
	});

	it('falls back to selected snapshot when subscribe response is malformed', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': { type: 'chat-subscribed', chatId: 'chat-1', mode: 'delta' },
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.panels.loadChatSnapshot).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).not.toHaveBeenCalled();
		expect(deps.chatState.applyMessages).not.toHaveBeenCalled();
	});

	it('replays hidden history when 25 newer visible chats fill the cursor shortlist', async () => {
		vi.useFakeTimers();
		localStorage.clear();
		const cache = new ChatTranscriptCache({ limit: 100 });
		const visibleChatIds = Array.from({ length: 25 }, (_, index) => `visible-${index}`);
		cache.setMountedChatIds(visibleChatIds);
		try {
			vi.setSystemTime(new Date(TS));
			const initial = [{ ordinal: 1, message: new AssistantMessage(TS, 'initial') }];
			cache.replace('hidden', 'view', initial, 1, null);
			vi.setSystemTime(new Date('2024-01-01T00:00:01.000Z'));
			for (const chatId of visibleChatIds) {
				cache.replace(chatId, 'view', initial, 1, null);
			}
			expect(cache.listCursors(20).map(({ chatId }) => chatId)).not.toContain('hidden');
			const deps = createReconnectDeps({
				selectedChatId: visibleChatIds[0],
				subscribeResponses: Object.fromEntries([
					...visibleChatIds.map((chatId) => [chatId, deltaResponse(chatId, 'view', [], 1)]),
					['hidden', deltaResponse('hidden', 'view', [messageJson(2, 'replayed')])],
				]),
			});
			deps.panels.visibleChatIds.mockReturnValue(visibleChatIds);
			deps.panels.panelsForChat.mockImplementation((chatId) =>
				visibleChatIds.includes(chatId) ? [{}] : [],
			);
			deps.panels.transcriptCache.readAppliedCursor.mockImplementation((chatId) =>
				cache.readAppliedCursor(chatId),
			);
			deps.panels.transcriptCache.markValidated.mockImplementation((chatId: string) =>
				cache.markValidated(chatId),
			);
			deps.panels.markChatStale.mockImplementation((chatId) => cache.markStale(chatId));
			deps.panels.transcriptCache.markStaleExcept.mockImplementation(ids => cache.markStaleExcept(ids));
			deps.panels.transcriptCache.trackReplayValidation.mockImplementation(id => cache.trackReplayValidation(id));
			deps.getBackgroundCursors.mockImplementation(limit => cache.listCursors(limit));
			const applyBackground: NonNullable<ChatReconnectCoordinatorOptions['onBackgroundMessages']> =
				(chatId, transcriptViewId, messages, firstOrdinal, lastOrdinal) =>
					cache.applyMessages(chatId, transcriptViewId, { messages, firstOrdinal, lastOrdinal })
						.status === 'applied';
			deps.onBackgroundMessages.mockImplementation(applyBackground);

			await reconnectAfterFirstConnection(deps);

			const subscribedIds = deps.ws.sendRequest.mock.calls
				.map(([request]) => request as Record<string, unknown>)
				.filter(request => request.type === 'chat-subscribe')
				.map(request => request.chatId);
			expect(subscribedIds.sort()).toEqual([...visibleChatIds, 'hidden'].sort());
			expect(deps.ws.sendRequest).toHaveBeenCalledWith({
				type: 'chat-subscribe',
				chatId: 'hidden',
				transcriptViewId: 'view',
				afterOrdinal: 1,
			});
			expect(cache.get('hidden')?.messages.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
			expect(deps.markBackgroundStale).not.toHaveBeenCalled();
		} finally {
			cache.flush();
			localStorage.clear();
			vi.useRealTimers();
		}
	});

	it('keeps omitted and queued background histories stale until authoritative recovery', async () => {
		localStorage.clear();
		const cache = new ChatTranscriptCache({ limit: 100 });
		const ids = Array.from({ length: 24 }, (_, index) => `background-${index}`);
		for (const chatId of ['chat-1', ...ids]) {
			cache.replace(chatId, 'view', [{ ordinal: 1, message: new AssistantMessage(TS, 'one') }], 1, null);
		}
		const lifecycle = new ConversationLifecycleState();
		const load = vi.fn<NonNullable<ConstructorParameters<typeof ConversationPanelRegistry>[0]['loadTranscriptSnapshot']>>(async (transcript, chatId) => {
			cache.replace(chatId, 'view', [1, 2].map(ordinal => ({ ordinal, message: new AssistantMessage(TS, `row-${ordinal}`) })), 2, null);
			transcript.installCachedSnapshot(chatId);
		});
		const panels = new ConversationPanelRegistry({ cache,
			overlays: new ConversationTranscriptOverlayStore(),
			lifecycle: { forChat: () => lifecycle, remove: () => {} },
			getSelectedChatId: () => 'chat-1', getComposerAnchorSurfaceId: () => 'chat-view:window-left',
			loadTranscriptSnapshot: load,
		});
		const visible = { surfaceId: 'chat-view:window-left', chatId: 'chat-1', presentation: 'window-left',
			windowId: 'window-left', snapshotAdmission: 'admitted' } as const;
		panels.reconcile([visible]);
		const deps = createReconnectDeps();
		const held = deferred<Record<string, unknown>>();
		const subscribed: string[] = [];
		deps.ws.sendRequest.mockImplementation(async request => {
			if (!('chatId' in request)) return reconnectStateResponse();
			const chatId = String(request.chatId);
			subscribed.push(chatId);
			if (chatId !== 'chat-1' && subscribed.filter(id => id !== 'chat-1').length === 1) return held.promise;
			return deltaResponse(chatId, 'view', [], 1);
		});
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels,
			getBackgroundCursors: limit => cache.listCursors(limit),
			markBackgroundStale: chatId => panels.markChatStale(chatId),
			onBackgroundMessages: (chatId, view, messages, firstOrdinal, lastOrdinal) =>
				cache.applyMessages(chatId, view, { messages, firstOrdinal, lastOrdinal }).status === 'applied',
		});
		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);
		for (const chatId of ids) expect(cache.get(chatId)?.stale).toBe(true);
		const first = subscribed.find(chatId => chatId !== 'chat-1')!;
		held.resolve(deltaResponse(first, 'view', [], 1));
		await reconnect;
		const omitted = ids.filter(chatId => !subscribed.includes(chatId));
		expect(omitted).toHaveLength(4);
		for (const chatId of ids) expect(cache.get(chatId)?.stale).toBe(omitted.includes(chatId));
		panels.reconcile([{ ...visible, chatId: omitted[0]! }]);
		await panels.loadChatSnapshot(omitted[0]!);
		expect(load).toHaveBeenCalledOnce();
		expect(cache.get(omitted[0]!)).toMatchObject({ lastOrdinal: 2, stale: false });
		panels.destroy();
		cache.flush();
		localStorage.clear();
	});

	it('leaves a queued background candidate stale when live delivery loses continuity', async () => {
		localStorage.clear();
		const { cache, panels } = snapshotRecoveryFixture(0);
		const cursors = ['chat-1', 'chat-2'].map(chatId => ({ chatId, transcriptViewId: 'view', lastOrdinal: 1 }));
		for (const { chatId } of cursors) {
			cache.replace(chatId, 'view', [{ ordinal: 1, message: new AssistantMessage(TS, 'row-1') }], 1, null);
		}
		const deps = createReconnectDeps({ selectedChatId: '', backgroundCursors: cursors });
		const held = deferred<Record<string, unknown>>();
		const subscribed: string[] = [];
		deps.ws.sendRequest.mockImplementation(async request => {
			if (!('chatId' in request)) return reconnectStateResponse();
			const chatId = String(request.chatId);
			subscribed.push(chatId);
			if (chatId === 'chat-1') return held.promise;
			return deltaResponse(chatId, 'view', [messageJson(2, 'row-2'), messageJson(3, 'row-3')]);
		});
		const coordinator = new ChatReconnectCoordinator({ ...deps, panels,
			markBackgroundStale: chatId => panels.markChatStale(chatId),
			onBackgroundMessages: (chatId, view, messages, firstOrdinal, lastOrdinal) =>
				cache.applyMessages(chatId, view, { messages, firstOrdinal, lastOrdinal }).status === 'applied',
		});
		try {
			await coordinator.handleConnectionState(true);
			await coordinator.handleConnectionState(false);
			const reconnect = coordinator.handleConnectionState(true);
			await flushUntil(() => subscribed.includes('chat-1'));
			expect(cache.applyMessages('chat-2', 'view', {
				messages: [{ ordinal: 3, message: new AssistantMessage(TS, 'row-3') }], firstOrdinal: 3, lastOrdinal: 3,
			}).status).toBe('gap-detected');
			held.resolve(deltaResponse('chat-1', 'view', [messageJson(2, 'row-2')]));
			await reconnect;
			expect(subscribed).toEqual(['chat-1']);
			expect(cache.readAppliedCursor('chat-1')).toMatchObject({ lastOrdinal: 2, stale: false });
			expect(cache.readAppliedCursor('chat-2')).toMatchObject({ lastOrdinal: 1, stale: true });
		} finally {
			panels.destroy();
			cache.flush();
			localStorage.clear();
		}
	});

	it('resumes a bounded set of background cached cursors', async () => {
		const backgroundCursors = Array.from({ length: 25 }, (_, index) => ({
			chatId: `chat-${index + 2}`,
			transcriptViewId: `generation-${index + 2}`,
			lastOrdinal: 1,
		}));
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: Object.fromEntries([
				['chat-1', deltaResponse('chat-1', 'generation-selected')],
				...backgroundCursors.map((cursor) => [
					cursor.chatId,
					deltaResponse(cursor.chatId, cursor.transcriptViewId, [messageJson(2, cursor.chatId)]),
				]),
			]),
		});

		await reconnectAfterFirstConnection(deps);

		const backgroundSubscribes = (deps.ws.sendRequest as ReturnType<typeof vi.fn>).mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe' && request.chatId !== 'chat-1');
		expect(backgroundSubscribes).toHaveLength(20);
		expect(deps.getBackgroundCursors).toHaveBeenCalledWith(21);
		expect(deps.onBackgroundMessages).toHaveBeenCalledTimes(20);
		expect(deps.panels.transcriptCache.markStaleExcept).toHaveBeenCalledWith(new Set(['chat-1']));
	});

	it('defers background snapshots for non-resumable cached cursors', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': snapshotRequiredResponse('chat-2', 'generation-3'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.markBackgroundStale).toHaveBeenCalledWith('chat-2');
		expect(deps.panels.loadChatSnapshot).not.toHaveBeenCalled();
	});

	it('defers background snapshots when background delta apply reports a gap', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', transcriptViewId: 'generation-2', lastOrdinal: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.onBackgroundMessages.mockResolvedValueOnce(false);

		await reconnectAfterFirstConnection(deps);

		expect(deps.markBackgroundStale).toHaveBeenCalledWith('chat-2');
		expect(deps.panels.loadChatSnapshot).not.toHaveBeenCalled();
	});

	it('marks twenty non-resumable background cursors stale without loading snapshots', async () => {
		const backgroundCursors = Array.from({ length: 20 }, (_, index) => ({
			chatId: `chat-${index + 2}`,
			transcriptViewId: `generation-${index + 2}`,
			lastOrdinal: 1,
		}));
		const subscribeResponses = Object.fromEntries(
			backgroundCursors.map((cursor) => [
				cursor.chatId,
				snapshotRequiredResponse(cursor.chatId, `next-${cursor.transcriptViewId}`),
			]),
		);
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				...subscribeResponses,
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.markBackgroundStale).toHaveBeenCalledTimes(20);
		expect(deps.markBackgroundStale.mock.calls.map(([chatId]) => chatId)).toEqual(
			backgroundCursors.map((cursor) => cursor.chatId),
		);
		expect(deps.panels.loadChatSnapshot).not.toHaveBeenCalled();
	});

	it('discards stale reconnect responses when a newer reconnect begins', async () => {
		const firstSubscribe = deferred<Record<string, unknown>>();
		let subscribeCount = 0;
		const deps = createReconnectDeps();
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					return reconnectStateResponse([], ['chat-1']);
				}
				if (request.type === 'chat-subscribe') {
					subscribeCount += 1;
					if (subscribeCount === 1) return firstSubscribe.promise;
					return deltaResponse('chat-1', 'generation-new', [messageJson(3, 'new')]);
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => subscribeCount === 1);
		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);

		firstSubscribe.resolve(deltaResponse('chat-1', 'generation-old', [messageJson(3, 'old')]));
		await Promise.all([first, second]);

		expect(deps.chatState.applyMessages).not.toHaveBeenCalledWith(
			'chat-1',
			'generation-old',
			expect.any(Array),
		);
	});

	it('discards a stale queue refresh after a newer reconnect begins', async () => {
		const firstQueue = deferred<Record<string, unknown>>();
		let queueQueryCount = 0;
		const deps = createReconnectDeps({ runningIds: ['chat-1'] });
		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		clearConnectionCalls(deps);
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					queueQueryCount += 1;
					return queueQueryCount === 1
						? firstQueue.promise
						: reconnectStateResponse(['chat-1'], ['chat-1'], { 'chat-1': controlState(true) });
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => queueQueryCount === 1);

		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);
		await second;

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
		firstQueue.resolve(reconnectStateResponse(['chat-1'], ['chat-1']));
		await first;

		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setExecutionControlFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			controlState(true),
		);
	});
});
