import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitPanePreviewStore } from '../split-pane-preview-store.svelte';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { LocalChatTranscriptStorage } from '../chat-transcript-storage';
import { AssistantMessage, UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

const TS = '2026-06-17T00:00:00.000Z';

function entry(seq: number, content: string): ChatViewMessage {
	return {
		seq,
		message: new AssistantMessage(TS, content) as ChatMessage,
	};
}

function userEntry(seq: number, content: string): ChatViewMessage {
	return {
		seq,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function page(messages: ChatViewMessage[], generationId = 'generation-1') {
	return {
		chatId: 'chat-1',
		generationId,
		messages,
		pendingUserInputs: [],
		lastSeq: messages.at(-1)?.seq ?? 0,
		pageOldestSeq: messages[0]?.seq ?? 0,
		hasMore: false,
		limit: 50,
	};
}

describe('SplitPanePreviewStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('restores a cached preview and exposes its cursor', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [userEntry(1, 'hello')], {
			generationId: 'generation-1',
			lastSeq: 1,
		});
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new SplitPanePreviewStore(transcriptCache);

		store.restore('chat-1');

		expect(store.entry('chat-1').messages).toHaveLength(1);
		expect(store.cursor('chat-1')).toEqual({
			chatId: 'chat-1',
			generationId: 'generation-1',
			lastSeq: 1,
		});
	});

	it('loads an HTTP snapshot and persists it through the shared cache', async () => {
		vi.mocked(getChatMessages).mockResolvedValueOnce(page([entry(1, 'loaded')]));
		const storage = new LocalChatTranscriptStorage();
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new SplitPanePreviewStore(transcriptCache);

		await store.loadSnapshot('chat-1');

		expect(getChatMessages).toHaveBeenCalledWith({ chatId: 'chat-1', limit: 50 });
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['loaded']);

		transcriptCache.flush();
		const restored = storage.restore('chat-1');
		expect(restored?.generationId).toBe('generation-1');
		expect(restored?.lastSeq).toBe(1);
	});

	it('applies contiguous messages and windows the preview', () => {
		const store = new SplitPanePreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1);

		const applied = store.applyMessages('chat-1', 'generation-1', [entry(2, 'second')], 2);

		expect(applied).toBe(true);
		expect(store.entry('chat-1').lastSeq).toBe(2);
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['first', 'second']);
	});

	it('marks stale when incoming messages belong to another generation', () => {
		const store = new SplitPanePreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1);

		const applied = store.applyMessages('chat-1', 'generation-2', [entry(2, 'second')], 2);

		expect(applied).toBe(false);
		expect(store.entry('chat-1').isStale).toBe(true);
	});

	it('marks stale when incoming messages have a seq gap', () => {
		const store = new SplitPanePreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1);

		const applied = store.applyMessages('chat-1', 'generation-1', [entry(3, 'third')], 3);

		expect(applied).toBe(false);
		expect(store.entry('chat-1').isStale).toBe(true);
		expect(store.entry('chat-1').lastSeq).toBe(1);
	});

	it('marks stale when server lastSeq remains ahead after apply', () => {
		const store = new SplitPanePreviewStore();
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'first')], 1);

		const applied = store.applyMessages('chat-1', 'generation-1', [entry(2, 'second')], 3);

		expect(applied).toBe(false);
		expect(store.entry('chat-1').isStale).toBe(true);
		expect(store.entry('chat-1').lastSeq).toBe(1);
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
		const store = new SplitPanePreviewStore();

		const first = store.loadSnapshot('chat-1');
		const second = store.loadSnapshot('chat-1');
		await second;
		resolveFirst(page([entry(1, 'old')], 'generation-old'));
		await first;

		expect(store.entry('chat-1').generationId).toBe('generation-new');
		expect(
			store.entry('chat-1').messages.map((item) => (item.message as AssistantMessage).content),
		).toEqual(['new']);
	});

	it('prunes preview entries and cached transcripts for chats that leave all panes', () => {
		const storage = new LocalChatTranscriptStorage();
		const transcriptCache = new ChatTranscriptCache({ limit: 50, storage });
		const store = new SplitPanePreviewStore(transcriptCache);
		store.replaceSnapshot('chat-1', 'generation-1', [entry(1, 'kept')], 1);
		store.replaceSnapshot('chat-2', 'generation-2', [entry(1, 'removed')], 1);
		transcriptCache.flush();

		store.prune(['chat-1']);

		expect(store.entry('chat-1').messages).toHaveLength(1);
		expect(store.entry('chat-2').messages).toEqual([]);
		expect(storage.restore('chat-1')).toBeTruthy();
		expect(storage.restore('chat-2')).toBeNull();
	});
});
