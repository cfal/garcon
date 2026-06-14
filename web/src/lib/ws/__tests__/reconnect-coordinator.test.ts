import { describe, expect, it, vi } from 'vitest';

import { ChatReconnectCoordinator } from '../reconnect-coordinator.svelte';
import type { ChatState } from '$lib/chat/state.svelte';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';
import type { WsConnection } from '../connection.svelte';

const TS = '2024-01-01T00:00:00.000Z';

function eventJson(seq: number, content: string) {
	return {
		appendSeq: seq,
		seq,
		messageId: `message-${seq}`,
		rev: 1,
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

function deltaResponse(chatId: string, logId = `log-${chatId}`, events: unknown[] = []) {
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		logId,
		mode: 'delta',
		events,
		lastAppendSeq: events.length,
	};
}

function snapshotRequiredResponse(chatId: string) {
	return {
		type: 'chat-subscribed',
		clientRequestId: `req-${chatId}`,
		chatId,
		logId: `log-${chatId}`,
		mode: 'snapshot-required',
		events: [],
		lastAppendSeq: 0,
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
	backgroundCursors?: Array<{ chatId: string; logId: string; lastAppendSeq: number }>;
} = {}) {
	const selectedChatId = options.selectedChatId ?? 'chat-1';
	const sendRequest = vi.fn(async (request: Record<string, unknown>) => {
		if (request.type === 'chats-running-query') return runningResponse(options.runningIds ?? []);
		if (request.type === 'chat-subscribe') {
			const chatId = String(request.chatId);
			return options.subscribeResponses?.[chatId] ?? deltaResponse(chatId);
		}
		throw new Error(`Unexpected request: ${String(request.type)}`);
	});
	const chatState = {
		getCursor: vi.fn(() => ({ logId: 'log-selected', lastAppendSeq: 2 })),
		applyEvents: vi.fn(() => 'applied'),
		loadMessages: vi.fn(async () => []),
		snapshotCache: {
			markStale: vi.fn(),
			markValidated: vi.fn(),
		},
	} as unknown as ChatState;
	const conversationUi = {
		setMessageQueue: vi.fn(),
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
		onBackgroundEvents: vi.fn(),
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
				'chat-1': deltaResponse('chat-1', 'log-selected', [eventJson(3, 'missed')]),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.reconcileProcessing).toHaveBeenCalledWith(new Set(['chat-1']));
		expect(deps.quietRefreshChats).toHaveBeenCalled();
		expect(deps.getQueue).toHaveBeenCalledWith('chat-1');
		expect(deps.ws.sendRequest).toHaveBeenCalledWith(expect.objectContaining({
			type: 'chat-subscribe',
			chatId: 'chat-1',
			logId: 'log-selected',
			afterAppendSeq: 2,
		}));
		expect(deps.chatState.applyEvents).toHaveBeenCalledWith(
			'log-selected',
			expect.arrayContaining([expect.objectContaining({ appendSeq: 3 })]),
		);
	});

	it('falls back to selected snapshot on snapshot-required subscribe response', async () => {
		const deps = createReconnectDeps({
			subscribeResponses: {
				'chat-1': snapshotRequiredResponse('chat-1'),
			},
		});

		await reconnectAfterFirstConnection(deps);

		expect(deps.chatState.loadMessages).toHaveBeenCalledWith('chat-1');
		expect(deps.chatState.snapshotCache.markValidated).toHaveBeenCalledWith('chat-1');
	});

	it('resumes a bounded set of background cached cursors', async () => {
		const backgroundCursors = Array.from({ length: 25 }, (_, index) => ({
			chatId: `chat-${index + 2}`,
			logId: `log-${index + 2}`,
			lastAppendSeq: 1,
		}));
		const deps = createReconnectDeps({
			selectedChatId: 'chat-1',
			backgroundCursors,
			subscribeResponses: Object.fromEntries([
				['chat-1', deltaResponse('chat-1', 'log-selected')],
				...backgroundCursors.map((cursor) => [
					cursor.chatId,
					deltaResponse(cursor.chatId, cursor.logId, [eventJson(2, cursor.chatId)]),
				]),
			]),
		});

		await reconnectAfterFirstConnection(deps);

		const backgroundSubscribes = (deps.ws.sendRequest as ReturnType<typeof vi.fn>).mock.calls
			.map(([request]) => request as Record<string, unknown>)
			.filter((request) => request.type === 'chat-subscribe' && request.chatId !== 'chat-1');
		expect(backgroundSubscribes).toHaveLength(20);
		expect(deps.onBackgroundEvents).toHaveBeenCalledTimes(20);
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
					return deltaResponse('chat-1', 'log-new', [eventJson(3, 'new')]);
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

		firstSubscribe.resolve(deltaResponse('chat-1', 'log-old', [eventJson(3, 'old')]));
		await Promise.all([first, second]);

		expect(deps.chatState.applyEvents).not.toHaveBeenCalledWith(
			'log-old',
			expect.any(Array),
		);
	});
});
