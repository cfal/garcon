import { describe, expect, it, vi } from 'vitest';

import { ChatReconnectCoordinator } from '../reconnect-coordinator.svelte';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import type { WsConnection } from '../connection.svelte';

const TS = '2024-01-01T00:00:00.000Z';

function messageJson(seq: number, content: string) {
	return {
		seq,
		message: { type: 'assistant-message', timestamp: TS, content },
	};
}

function runningResponse(ids: string[] = []) {
	return {
		type: 'chat-sessions-running',
		clientRequestId: 'req-running',
		sessions: { claude: ids.map((id) => ({ id })) },
	};
}

function deltaResponse(chatId: string, generationId = `generation-${chatId}`, messages: unknown[] = []) {
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

function snapshotRequiredResponse(chatId: string, generationId: string | null = `generation-${chatId}`) {
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
	for (let attempt = 0; attempt < 10; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error('Condition was not reached');
}

function createReconnectDeps(options: {
	selectedChatId?: string | null;
	runningIds?: string[];
	subscribeResponses?: Record<string, Record<string, unknown>>;
	backgroundCursors?: Array<{ chatId: string; generationId: string; lastSeq: number }>;
} = {}) {
	const selectedChatId = options.selectedChatId ?? 'chat-1';
	let selectedCursor = { generationId: 'generation-selected', lastSeq: 2 };
	const sendRequest = vi.fn(async (request: Record<string, unknown>) => {
		if (request.type === 'chats-running-query') return runningResponse(options.runningIds ?? []);
		if (request.type === 'chat-subscribe') {
			const chatId = String(request.chatId);
			return options.subscribeResponses?.[chatId] ?? deltaResponse(chatId);
		}
		throw new Error(`Unexpected request: ${String(request.type)}`);
	});
	const chatState = {
		getCursor: vi.fn(() => selectedCursor),
		applyMessages: vi.fn((generationId: string, messages: Array<{ seq?: unknown }>) => {
			const last = messages.at(-1);
			if (typeof last?.seq === 'number') {
				selectedCursor = { generationId, lastSeq: last.seq };
			}
			return 'applied';
		}),
		loadMessages: vi.fn(async () => []),
		snapshotCache: {
			markStale: vi.fn(),
			markValidated: vi.fn(),
		},
	} as unknown as ChatState;
	const conversationUi = {
		setMessageQueue: vi.fn(),
		setMessageQueueFromRefresh: vi.fn(),
	} as unknown as ConversationUiStore;

	return {
		ws: { sendRequest } as unknown as WsConnection,
		chatState,
		conversationUi,
		getSelectedChat: vi.fn(() => selectedChatId ? { id: selectedChatId, status: 'idle' } : null),
		getSelectedChatId: vi.fn(() => selectedChatId),
		getQueue: vi.fn(async () => ({ queue: { entries: [], paused: false } })),
		reconcileProcessing: vi.fn(),
		quietRefreshChats: vi.fn(async () => undefined),
		getBackgroundCursors: vi.fn(() => options.backgroundCursors ?? []),
		loadBackgroundSnapshot: vi.fn(async () => undefined),
		onBackgroundMessages: vi.fn(),
	};
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
		expect(deps.getQueue).toHaveBeenCalledWith('chat-1');
		expect(deps.ws.sendRequest).toHaveBeenCalledWith(expect.objectContaining({
			type: 'chat-subscribe',
			chatId: 'chat-1',
			generationId: 'generation-selected',
			afterSeq: 2,
		}));
		expect(deps.chatState.applyMessages).toHaveBeenCalledWith(
			'generation-selected',
			expect.arrayContaining([expect.objectContaining({ seq: 3 })]),
		);
	});

	it('falls back to selected snapshot on snapshot-required subscribe response', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': snapshotRequiredResponse('chat-1', null),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.snapshotCache.markValidated).toHaveBeenCalledWith('chat-1');
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
		expect(deps.chatState.snapshotCache.markValidated).toHaveBeenCalledWith('chat-1');
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
		expect(deps.chatState.snapshotCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('falls back to selected snapshot when subscribe request fails', async () => {
		const deps = createReconnectDeps();
		(deps.ws.sendRequest as ReturnType<typeof vi.fn>).mockImplementation(
			async (request: Record<string, unknown>) => {
				if (request.type === 'chats-running-query') return runningResponse([]);
				if (request.type === 'chat-subscribe') throw new Error('network down');
				throw new Error(`Unexpected request: ${String(request.type)}`);
			},
		);

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.snapshotCache.markValidated).toHaveBeenCalledWith('chat-1');
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
		expect(deps.chatState.snapshotCache.markValidated).toHaveBeenCalledWith('chat-1');
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
				if (request.type === 'chats-running-query') return runningResponse([]);
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
			'generation-old',
			expect.any(Array),
		);
	});
});
