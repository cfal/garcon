import { beforeEach, describe, expect, it } from 'vitest';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { LocalChatTranscriptStorage } from '$lib/chat/transcript/chat-transcript-storage.js';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage, ChatViewPage } from '$shared/chat-view';

const TS = '2024-01-01T00:00:00.000Z';

function entry(seq: number, content: string): ChatViewMessage {
	return {
		seq,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function page(
	generationId: string,
	messages: ChatViewMessage[],
	lastSeq = messages.at(-1)?.seq ?? 0,
): ChatViewPage {
	return {
		generationId,
		messages,
		lastSeq,
		pageOldestSeq: messages[0]?.seq ?? 0,
		hasMore: false,
	};
}

function contents(messages: ChatViewMessage[]): string[] {
	return messages.map((item) => (item.message as UserMessage).content);
}

describe('ChatTranscriptCache', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('applies contiguous messages in memory before persistence flush', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 100, storage, persistenceDelayMs: 1000 });

		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
		const applied = cache.applyMessages('chat-1', 'generation-1', [entry(2, 'two')]);

		expect(applied).toEqual({ status: 'applied', changed: true, lastSeq: 2 });
		expect(cache.get('chat-1')?.messages.map((item) => item.seq)).toEqual([1, 2]);
		expect(storage.restore('chat-1')).toBeNull();

		cache.flush();
		expect(storage.restore('chat-1')?.entries.map((item) => item.seq)).toEqual([1, 2]);
	});

	it('hydrates from storage when memory does not have an entry', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [entry(1, 'one')], { generationId: 'generation-1', lastSeq: 1 });
		const cache = new ChatTranscriptCache({ limit: 100, storage });

		expect(cache.get('chat-1')?.messages.map((item) => item.seq)).toEqual([1]);
	});

	it('allows live creation only when the first batch starts at seq 1', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });

		const created = cache.applyMessages('chat-1', 'generation-1', [entry(1, 'one')]);
		const missingBase = cache.applyMessages('chat-2', 'generation-1', [entry(4, 'tail')]);

		expect(created.status).toBe('applied');
		expect(contents(cache.get('chat-1')?.messages ?? [])).toEqual(['one']);
		expect(missingBase.status).toBe('missing-base');
		expect(cache.get('chat-2')).toBeNull();
	});

	it('marks transcripts stale on generation mismatch', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		const result = cache.applyMessages('chat-1', 'generation-2', [entry(2, 'two')]);

		expect(result.status).toBe('generation-changed');
		expect(cache.get('chat-1')?.stale).toBe(true);
	});

	it('detects seq gaps without advancing the cursor', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		const result = cache.applyMessages('chat-1', 'generation-1', [entry(3, 'three')]);

		expect(result).toEqual({
			status: 'gap-detected',
			expectedSeq: 2,
			receivedSeq: 3,
		});
		expect(cache.get('chat-1')?.lastSeq).toBe(1);
		expect(cache.get('chat-1')?.stale).toBe(true);
	});

	it('rejects replay deltas when server lastSeq is ahead of applied messages', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		const result = cache.applyMessages('chat-1', 'generation-1', [entry(2, 'two')], 3);

		expect(result).toEqual({ status: 'server-ahead', lastSeq: 2, serverLastSeq: 3 });
		expect(cache.get('chat-1')?.lastSeq).toBe(1);
	});

	it('lists memory cursors before persisted fallback cursors', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('persisted', [entry(1, 'persisted')], {
			generationId: 'generation-persisted',
			lastSeq: 1,
		});
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.replaceFromPage('memory', page('generation-memory', [entry(1, 'memory')]));

		expect(cache.listCursors()).toEqual([
			{ chatId: 'memory', generationId: 'generation-memory', lastSeq: 1 },
			{ chatId: 'persisted', generationId: 'generation-persisted', lastSeq: 1 },
		]);
	});

	it('prunes memory entries after maxEntries is exceeded', () => {
		const cache = new ChatTranscriptCache({ limit: 100, maxEntries: 2 });

		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
		cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'two')]));
		cache.replaceFromPage('chat-3', page('generation-3', [entry(1, 'three')]));

		expect(cache.get('chat-1')).toBeNull();
		expect(cache.get('chat-2')).not.toBeNull();
		expect(cache.get('chat-3')).not.toBeNull();
	});
});
