import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatWindowPreviewStore } from '../chat-window-preview-store.svelte.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte.js';
import { LocalChatTranscriptStorage } from '$lib/chat/transcript/chat-transcript-storage.js';
import { AssistantMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

const TS = '2026-06-17T00:00:00.000Z';

function entry(ordinal: number, content: string): TranscriptMessage {
	return {
		ordinal,
		message: new AssistantMessage(TS, content) as ChatMessage,
	};
}

function userEntry(ordinal: number, content: string): TranscriptMessage {
	return {
		ordinal,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function page(messages: TranscriptMessage[], transcriptViewId = 'generation-1') {
	return {
		historyState: { kind: 'complete' as const },
		chatId: 'chat-1',
		transcriptViewId,
		messages,
		resendCandidates: [],
		lastOrdinal: messages.at(-1)?.ordinal ?? 0,
		pageOldestOrdinal: messages[0]?.ordinal ?? 0,
		pageNewestOrdinal: messages.at(-1)?.ordinal ?? 0,
		nextBeforeOrdinal: null,
		hasMore: false,
		limit: 50,
	};
}

function boundedNewestPage(
	messages: TranscriptMessage[],
	pageNewestOrdinal: number,
	nextBeforeOrdinal: number | null,
) {
	return {
		...page(messages),
		lastOrdinal: 150,
		pageOldestOrdinal: messages[0]?.ordinal ?? 0,
		pageNewestOrdinal,
		nextBeforeOrdinal,
		hasMore: nextBeforeOrdinal !== null,
	};
}

describe('ChatWindowPreviewStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('restores a cached preview and exposes its cursor', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [userEntry(1, 'hello')], {
			transcriptViewId: 'generation-1',
			nextBeforeOrdinal: null,
			lastOrdinal: 1,
		});
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new ChatWindowPreviewStore(transcriptCache);

		store.restore('chat-1');

		expect(store.entry('chat-1').messages).toHaveLength(1);
		expect(store.cursor('chat-1')).toEqual({
			chatId: 'chat-1',
			transcriptViewId: 'generation-1',
			lastOrdinal: 1,
		});
	});

	it('[TLV5-L09.03-WEB-PREVIEW-01] loads a Chat-window preview without activation', async () => {
		vi.mocked(getChatMessages).mockResolvedValueOnce(page([entry(1, 'loaded')]));
		const storage = new LocalChatTranscriptStorage();
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new ChatWindowPreviewStore(transcriptCache);

		await store.loadSnapshot('chat-1');

		expect(getChatMessages).toHaveBeenCalledWith({ chatId: 'chat-1', limit: 50 });
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['loaded']);

		transcriptCache.flush();
		const restored = storage.restore('chat-1');
		expect(restored?.transcriptViewId).toBe('generation-1');
		expect(restored?.lastOrdinal).toBe(1);
	});

	it('[TLV5-PAGE.09-WEB-WINDOW-PREVIEW-01] fills a window preview across trailing hidden raw budgets', async () => {
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce(boundedNewestPage([], 150, 101))
			.mockResolvedValueOnce(boundedNewestPage([], 100, 51))
			.mockResolvedValueOnce(
				boundedNewestPage(
					Array.from({ length: 50 }, (_, index) => entry(index + 1, `message-${index + 1}`)),
					50,
					null,
				),
			);
		const transcriptCache = new ChatTranscriptCache({ limit: 50 });
		const replaceFromPage = vi.spyOn(transcriptCache, 'replaceFromPage');
		const store = new ChatWindowPreviewStore(transcriptCache);

		await store.loadSnapshot('chat-1');

		expect(vi.mocked(getChatMessages).mock.calls.map(([request]) => request)).toEqual([
			{ chatId: 'chat-1', limit: 50 },
			{ chatId: 'chat-1', limit: 50, beforeOrdinal: 101, transcriptViewId: 'generation-1' },
			{ chatId: 'chat-1', limit: 50, beforeOrdinal: 51, transcriptViewId: 'generation-1' },
		]);
		expect(replaceFromPage).toHaveBeenCalledOnce();
		expect(store.entry('chat-1').messages.map((item) => item.ordinal)).toEqual(
			Array.from({ length: 50 }, (_, index) => index + 1),
		);
		expect(store.entry('chat-1').lastOrdinal).toBe(150);
		expect(transcriptCache.get('chat-1')?.nextBeforeOrdinal).toBeNull();
	});

	it('shows degraded history without exposing a preview cursor', async () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 50 });
		transcriptCache.replaceFromPage('chat-1', page([entry(1, 'stale')]));
		vi.mocked(getChatMessages).mockResolvedValueOnce({
			historyState: {
				kind: 'degraded',
				errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
				retryable: false,
			},
			chatId: 'chat-1',
			messages: [],
		});
		const store = new ChatWindowPreviewStore(transcriptCache);

		await store.loadSnapshot('chat-1');

		expect(store.entry('chat-1')).toMatchObject({
			transcriptViewId: null,
			lastOrdinal: 0,
			messages: [],
			isLoading: false,
			error: expect.any(String),
		});
		expect(store.cursor('chat-1')).toBeNull();
		expect(transcriptCache.get('chat-1')).toBeNull();
	});

	it('applies contiguous messages and windows the preview', () => {
		const store = new ChatWindowPreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1, null);

		const applied = store.applyMessages('chat-1', 'generation-1', [entry(2, 'second')], 2, 2);

		expect(applied).toBe(true);
		expect(store.entry('chat-1').lastOrdinal).toBe(2);
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['first', 'second']);
	});

	it('marks stale when incoming messages belong to another generation', () => {
		const store = new ChatWindowPreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1, null);

		const applied = store.applyMessages('chat-1', 'generation-2', [entry(2, 'second')], 2, 2);

		expect(applied).toBe(false);
		expect(store.entry('chat-1').isStale).toBe(true);
	});

	it('marks stale when incoming messages have a ordinal gap', () => {
		const store = new ChatWindowPreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1, null);

		const applied = store.applyMessages('chat-1', 'generation-1', [entry(3, 'third')], 3, 3);

		expect(applied).toBe(false);
		expect(store.entry('chat-1').isStale).toBe(true);
		expect(store.entry('chat-1').lastOrdinal).toBe(1);
	});

	it('advances across a hidden ledger row after the visible append', () => {
		const store = new ChatWindowPreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1, null);

		const applied = store.applyMessages('chat-1', 'generation-1', [entry(2, 'second')], 2, 3);

		expect(applied).toBe(true);
		expect(store.entry('chat-1').isStale).toBe(false);
		expect(store.entry('chat-1').lastOrdinal).toBe(3);
	});

	it('ignores stale snapshot load results', async () => {
		let resolveFirst!: (value: ReturnType<typeof page>) => void;
		vi.mocked(getChatMessages)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
			)
			.mockResolvedValueOnce(page([entry(1, 'new')], 'generation-new'));
		const store = new ChatWindowPreviewStore();

		const first = store.loadSnapshot('chat-1');
		const second = store.loadSnapshot('chat-1');
		await second;
		resolveFirst(page([entry(1, 'old')], 'generation-old'));
		await first;

		expect(store.entry('chat-1').transcriptViewId).toBe('generation-new');
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['new']);
	});

	it('does not let an older HTTP snapshot overwrite a newer live delta', async () => {
		let resolveSnapshot!: (value: ReturnType<typeof page>) => void;
		vi.mocked(getChatMessages).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveSnapshot = resolve;
			}),
		);
		const store = new ChatWindowPreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1, null);

		const load = store.loadSnapshot('chat-1');
		expect(store.applyMessages('chat-1', 'generation-1', [entry(2, 'live')], 2, 2)).toBe(true);
		resolveSnapshot(page([entry(1, 'first')], 'generation-1'));
		await load;

		expect(store.entry('chat-1').lastOrdinal).toBe(2);
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['first', 'live']);
	});

	it('prunes preview entries without deleting shared cache snapshots', () => {
		const storage = new LocalChatTranscriptStorage();
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new ChatWindowPreviewStore(transcriptCache);
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'kept')], 1, null);
		store.replaceSnapshot('chat-2', 'generation-2', [entry(1, 'removed')], 1, null);
		transcriptCache.flush();

		store.prune(['chat-1']);

		expect(store.entry('chat-1').messages).toHaveLength(1);
		expect(store.entry('chat-2').messages).toEqual([]);
		expect(storage.restore('chat-1')).toBeTruthy();
		expect(storage.restore('chat-2')).toBeTruthy();
		expect(transcriptCache.get('chat-2')?.transcriptViewId).toBe('generation-2');
		expect(storage.listCursors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					chatId: 'chat-1',
					transcriptViewId: 'generation-1',
					lastOrdinal: 1,
				}),
				expect.objectContaining({
					chatId: 'chat-2',
					transcriptViewId: 'generation-2',
					lastOrdinal: 1,
				}),
			]),
		);
	});

	it('keeps pruned cache entries contiguous for later stream batches', () => {
		const transcriptCache = new ChatTranscriptCache({ limit: 50 });
		const store = new ChatWindowPreviewStore(transcriptCache);
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1, null);

		store.prune([]);
		const result = transcriptCache.applyMessages('chat-1', 'generation-1', {
			firstOrdinal: 2,
			lastOrdinal: 2,
			messages: [entry(2, 'second')],
		});

		expect(result).toEqual({ status: 'applied', changed: true, lastOrdinal: 2 });
		expect(transcriptCache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([1, 2]);
	});

	it('removes preview entries and cached transcripts when a chat is deleted everywhere', () => {
		const storage = new LocalChatTranscriptStorage();
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new ChatWindowPreviewStore(transcriptCache);
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'deleted')], 1, null);
		transcriptCache.flush();

		store.remove('chat-1');

		expect(store.entry('chat-1').messages).toEqual([]);
		expect(transcriptCache.get('chat-1')).toBeNull();
		expect(storage.restore('chat-1')).toBeNull();
	});
});
