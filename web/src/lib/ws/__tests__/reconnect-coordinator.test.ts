import { describe, expect, it, vi } from 'vitest';

import {
	ChatReconnectCoordinator,
	type ChatReconnectCoordinatorOptions,
	type ReconnectTranscriptState,
} from '../reconnect-coordinator.svelte';
import type { QueueState } from '$shared/queue-state';

const TS = '2024-01-01T00:00:00.000Z';

function queueState(paused: boolean): QueueState {
	return {
		entries: paused
			? [{
					id: 'queued-1',
					content: 'queued',
					revision: 1,
					createdAt: TS,
					updatedAt: TS,
				}]
			: [],
		dispatchingEntryId: null,
		recentlyDispatched: [],
		pause: paused ? { id: 'pause-1', kind: 'manual', pausedAt: TS } : null,
		version: paused ? 2 : 1,
		updatedAt: TS,
	};
}

function messageJson(seq: number, content: string) {
	return {
		seq,
		message: { type: 'assistant-message', timestamp: TS, content },
	};
}

function reconnectStateResponse(
	runningIds: string[] = [],
	chatIds: string[] = [],
	queueStates: Record<string, QueueState> | undefined = {},
) {
	return {
		type: 'reconnect-state',
		clientRequestId: 'req-reconnect',
		sessions: { claude: runningIds.map((id) => ({ id })) },
		queueResults: chatIds.map((chatId) => ({
			chatId,
			outcome: 'snapshot',
			queue: queueStates?.[chatId] ?? queueState(false),
		})),
	};
}

function deltaResponse(
	chatId: string,
	generationId = `generation-${chatId}`,
	messages: unknown[] = [],
) {
	const last = messages.at(-1) as { seq?: unknown } | undefined;
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		generationId,
		mode: 'delta',
		messages,
		lastSeq: typeof last?.seq === 'number' ? last.seq : 0,
	};
}

function snapshotRequiredResponse(
	chatId: string,
	generationId: string | null = `generation-${chatId}`,
) {
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		generationId,
		mode: 'snapshot-required',
		messages: [],
		lastSeq: 0,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
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
		selectedStatus?: 'idle' | 'running';
		runningIds?: string[];
		subscribeResponses?: Record<string, Record<string, unknown>>;
		backgroundCursors?: Array<{ chatId: string; generationId: string; lastSeq: number }>;
		visibleChatIds?: string[];
		queueChatIds?: string[];
		queueStates?: Record<string, QueueState>;
		visibleCursors?: Record<
			string,
			{ chatId: string; generationId: string; lastSeq: number } | null
		>;
	} = {},
) {
	const selectedChatId = options.selectedChatId ?? 'chat-1';
	let selectedCursor = { generationId: 'generation-selected', lastSeq: 2 };
	const sendRequest = vi.fn(async (request: object) => {
		if (!('type' in request)) throw new Error('Request is missing a type');
		if (request.type === 'reconnect-state-query') {
			const chatIds = 'queueChatIds' in request && Array.isArray(request.queueChatIds)
				? request.queueChatIds.filter((chatId): chatId is string => typeof chatId === 'string')
				: [];
			return reconnectStateResponse(options.runningIds ?? [], chatIds, options.queueStates);
		}
		if (request.type === 'chat-subscribe') {
			const chatId = 'chatId' in request ? String(request.chatId) : '';
			return options.subscribeResponses?.[chatId] ?? deltaResponse(chatId);
		}
		throw new Error(`Unexpected request: ${String(request.type)}`);
	});
	const chatState = {
		getCursor: vi.fn(() => selectedCursor),
		applyMessages: vi.fn(
			(_chatId: string, generationId: string, messages: Array<{ seq?: unknown }>) => {
				const last = messages.at(-1);
				if (typeof last?.seq === 'number') {
					selectedCursor = { generationId, lastSeq: last.seq };
				}
				return 'applied' as const;
			},
		),
		loadMessages: vi.fn(async () => []),
		transcriptCache: {
			markStale: vi.fn(),
			markValidated: vi.fn(),
		},
	} satisfies ReconnectTranscriptState;
	const conversationUi = {
		queueChatIds: options.queueChatIds ?? [],
		removeMessageQueue: vi.fn(),
		setMessageQueueFromRefresh: vi.fn(),
	};

	return {
		ws: { isConnected: true, sendRequest },
		chatState,
		conversationUi,
		getSelectedChat: vi.fn(() =>
			selectedChatId
				? { id: selectedChatId, status: options.selectedStatus ?? 'idle' }
				: null,
		),
		getSelectedChatId: vi.fn(() => selectedChatId),
		getQueue: vi.fn(async (_chatId: string): Promise<{ queue: QueueState }> => ({
			queue: queueState(false),
		})),
		reconcileProcessing: vi.fn(),
		quietRefreshChats: vi.fn(async () => undefined),
		getBackgroundCursors: vi.fn(() => options.backgroundCursors ?? []),
		getVisibleChatIds: vi.fn(() => options.visibleChatIds ?? []),
		getVisibleChatCursor: vi.fn((chatId: string) => options.visibleCursors?.[chatId] ?? null),
		loadVisibleChatSnapshot: vi.fn(async () => undefined),
		onVisibleChatMessages: vi.fn(),
		loadBackgroundSnapshot: vi.fn(async () => undefined),
		onBackgroundMessages: vi.fn(),
	} satisfies ChatReconnectCoordinatorOptions;
}

async function reconnectAfterFirstConnection(
	deps: ReturnType<typeof createReconnectDeps>,
): Promise<void> {
	const coordinator = new ChatReconnectCoordinator(deps);
	await coordinator.handleConnectionState(true);
	await coordinator.handleConnectionState(false);
	await coordinator.handleConnectionState(true);
}

describe('ChatReconnectCoordinator', () => {
	it('does nothing on first connection', async () => {
		const deps = createReconnectDeps();
		const coordinator = new ChatReconnectCoordinator(deps);

		await coordinator.handleConnectionState(true);

		expect(deps.ws.sendRequest).not.toHaveBeenCalled();
		expect(deps.quietRefreshChats).not.toHaveBeenCalled();
	});

	it('reconciles running sessions, refreshes chats, and resumes the selected chat', async () => {
		const deps = createReconnectDeps({
			runningIds: ['chat-1'],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'missed')]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
		expect(deps.quietRefreshChats).toHaveBeenCalled();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			queueChatIds: ['chat-1'],
		});
		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			queueState(false),
		);
		expect(deps.getQueue).not.toHaveBeenCalled();
		expect(deps.ws.sendRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'chat-subscribe',
				chatId: 'chat-1',
				generationId: 'generation-selected',
				afterSeq: 2,
			}),
		);
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ seq: 3 })]),
		);
	});

	it('resumes the selected chat without waiting for control-state reconciliation', async () => {
		const controlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps();
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return controlState.promise;
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'missed')]);
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await flushUntil(() => deps.chatState.transcriptCache.markValidated.mock.calls.length === 1);
		expect(deps.reconcileProcessing).not.toHaveBeenCalled();
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'chat-1',
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ seq: 3 })]),
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
		await coordinator.handleConnectionState(false);
		const reconnect = coordinator.handleConnectionState(true);

		await flushUntil(
			() => deps.conversationUi.setMessageQueueFromRefresh.mock.calls.length === 1,
		);
		expect(deps.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
		expect(deps.quietRefreshChats).toHaveBeenCalledOnce();
		expect(deps.getQueue).not.toHaveBeenCalled();
		expect(deps.getVisibleChatIds).not.toHaveBeenCalled();

		selectedSubscribe.resolve(deltaResponse('chat-1'));
		await reconnect;
	});

	it('refreshes the selected queue even when the chat is idle', async () => {
		const deps = createReconnectDeps({ runningIds: [] });

		await reconnectAfterFirstConnection(deps);

		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			queueChatIds: ['chat-1'],
		});
		expect(deps.getQueue).not.toHaveBeenCalled();
	});

	it('refreshes cached background queues after reconnect', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			queueChatIds: ['chat-1', 'chat-2', 'chat-3'],
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.ws.sendRequest).toHaveBeenCalledWith({
			type: 'reconnect-state-query',
			queueChatIds: ['chat-1', 'chat-2', 'chat-3'],
		});
		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledTimes(3);
		expect(deps.getQueue).not.toHaveBeenCalled();
	});

	it('falls back to HTTP only for a reconnect snapshot omitted by the server', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			queueChatIds: ['chat-1', 'chat-2'],
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

		expect(deps.getQueue).toHaveBeenCalledTimes(1);
		expect(deps.getQueue).toHaveBeenCalledWith('chat-2');
		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			queueState(false),
		);
		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledWith(
			'chat-2',
			queueState(false),
		);
	});

	it('does not block transcript resume on the reconnect control-state request', async () => {
		const heldControlState = deferred<Record<string, unknown>>();
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			queueChatIds: ['chat-2'],
			visibleChatIds: ['chat-3'],
			visibleCursors: {
				'chat-3': { chatId: 'chat-3', generationId: 'generation-3', lastSeq: 1 },
			},
			backgroundCursors: [
				{ chatId: 'chat-4', generationId: 'generation-4', lastSeq: 1 },
			],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-3': deltaResponse('chat-3', 'generation-3', [messageJson(2, 'visible')]),
				'chat-4': deltaResponse('chat-4', 'generation-4', [messageJson(2, 'background')]),
			},
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') return heldControlState.promise;
				if (request.type === 'chat-subscribe') {
					const chatId = String(request.chatId ?? '');
					return deps.getVisibleChatIds().includes(chatId) || chatId === 'chat-4'
						? deltaResponse(chatId, `generation-${chatId.slice(-1)}`, [messageJson(2, chatId)])
						: deltaResponse(chatId, 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		await coordinator.handleConnectionState(false);
		let reconnectSettled = false;
		const reconnect = coordinator.handleConnectionState(true).then(() => {
			reconnectSettled = true;
		});

		await flushUntil(
			() =>
				deps.onVisibleChatMessages.mock.calls.length === 1 &&
				deps.onBackgroundMessages.mock.calls.length === 1,
		);
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

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('falls back to selected snapshot when reconnect replay detects a seq gap', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected', [messageJson(5, 'later')]),
			},
		});
		(deps.chatState.applyMessages as ReturnType<typeof vi.fn>).mockReturnValueOnce('gap-detected');

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('falls back to selected snapshot when reconnect delta lastSeq stays ahead after apply', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': {
					...deltaResponse('chat-1', 'generation-selected', [messageJson(3, 'partial')]),
					lastSeq: 4,
				},
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
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

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.applyMessages).not.toHaveBeenCalled();
	});

	it('falls back to selected snapshot when subscribe response is malformed', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': { type: 'chat-subscribed', chatId: 'chat-1', mode: 'delta' },
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.transcriptCache.markValidated).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.applyMessages).not.toHaveBeenCalled();
	});

	it('resumes a bounded set of background cached cursors', async () => {
		const backgroundCursors = Array.from({ length: 25 }, (_, index) => ({
			chatId: `chat-${index + 2}`,
			generationId: `generation-${index + 2}`,
			lastSeq: 1,
		}));
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: Object.fromEntries([
				['chat-1', deltaResponse('chat-1', 'generation-selected')],
				...backgroundCursors.map((cursor) => [
					cursor.chatId,
					deltaResponse(cursor.chatId, cursor.generationId, [messageJson(2, cursor.chatId)]),
				]),
			]),
		});

		await reconnectAfterFirstConnection(deps);

		const backgroundSubscribes = (deps.ws.sendRequest as ReturnType<typeof vi.fn>).mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe' && request.chatId !== 'chat-1');
		expect(backgroundSubscribes).toHaveLength(20);
		expect(deps.onBackgroundMessages).toHaveBeenCalledTimes(20);
	});

	it('resumes visible split-pane chats before bounded background cursors', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			visibleChatIds: ['chat-2'],
			visibleCursors: {
				'chat-2': { chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
			},
			backgroundCursors: [
				{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
				{ chatId: 'chat-3', generationId: 'generation-3', lastSeq: 1 },
			],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(2, 'visible')]),
				'chat-3': deltaResponse('chat-3', 'generation-3', [messageJson(2, 'background')]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.onVisibleChatMessages).toHaveBeenCalledWith(
			'chat-2',
			'generation-2',
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
			2,
		);
		expect(deps.onBackgroundMessages).toHaveBeenCalledTimes(1);
		expect(deps.onBackgroundMessages).toHaveBeenCalledWith(
			'chat-3',
			'generation-3',
			expect.arrayContaining([expect.objectContaining({ seq: 2 })]),
			2,
		);

		const subscribeOrder = (deps.ws.sendRequest as ReturnType<typeof vi.fn>).mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe')
			.map((request) => request.chatId);
		expect(subscribeOrder).toEqual(['chat-1', 'chat-2', 'chat-3']);
	});

	it('loads visible split-pane snapshots when no visible cursor exists', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			visibleChatIds: ['chat-2'],
			visibleCursors: { 'chat-2': null },
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadVisibleChatSnapshot).toHaveBeenCalledWith('chat-2');
		expect(deps.ws.sendRequest).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'chat-subscribe',
				chatId: 'chat-2',
			}),
		);
	});

	it('loads visible split-pane snapshots when visible apply reports a gap', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			visibleChatIds: ['chat-2'],
			visibleCursors: {
				'chat-2': { chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 },
			},
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.onVisibleChatMessages.mockResolvedValueOnce(false);

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadVisibleChatSnapshot).toHaveBeenCalledWith('chat-2');
	});

	it('loads background snapshots for non-resumable cached cursors', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': snapshotRequiredResponse('chat-2', 'generation-3'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadBackgroundSnapshot).toHaveBeenCalledWith('chat-2');
	});

	it('loads background snapshots when background delta apply reports a gap', async () => {
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors: [{ chatId: 'chat-2', generationId: 'generation-2', lastSeq: 1 }],
			subscribeResponses: {
				'chat-1': deltaResponse('chat-1', 'generation-selected'),
				'chat-2': deltaResponse('chat-2', 'generation-2', [messageJson(3, 'later')]),
			},
		});
		deps.onBackgroundMessages.mockResolvedValueOnce(false);

		await reconnectAfterFirstConnection(deps);

		expect(deps.loadBackgroundSnapshot).toHaveBeenCalledWith('chat-2');
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
		const deps = createReconnectDeps({
			selectedStatus: 'running',
			runningIds: ['chat-1'],
		});
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'reconnect-state-query') {
					queueQueryCount += 1;
					return queueQueryCount === 1
						? firstQueue.promise
						: reconnectStateResponse(
								['chat-1'],
								['chat-1'],
								{ 'chat-1': queueState(true) },
							);
				}
				if (request.type === 'chat-subscribe') {
					return deltaResponse('chat-1', 'generation-selected');
				}
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		const coordinator = new ChatReconnectCoordinator(deps);
		await coordinator.handleConnectionState(true);
		await flushUntil(
			() => deps.conversationUi.setMessageQueueFromRefresh.mock.calls.length === 1,
		);
		deps.conversationUi.setMessageQueueFromRefresh.mockClear();
		await coordinator.handleConnectionState(false);
		const first = coordinator.handleConnectionState(true);
		await flushUntil(() => queueQueryCount === 1);

		await coordinator.handleConnectionState(false);
		const second = coordinator.handleConnectionState(true);
		await second;

		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			queueState(true),
		);

		firstQueue.resolve(reconnectStateResponse(['chat-1'], ['chat-1']));
		await first;

		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledTimes(1);
		expect(deps.conversationUi.setMessageQueueFromRefresh).toHaveBeenCalledWith(
			'chat-1',
			queueState(true),
		);
	});
});
