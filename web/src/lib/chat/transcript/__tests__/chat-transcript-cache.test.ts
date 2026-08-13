import { beforeEach, describe, expect, it } from 'vitest';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { LocalChatTranscriptStorage } from '$lib/chat/transcript/chat-transcript-storage.js';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage, TranscriptPage } from '$shared/chat-view';

const TS = '2024-01-01T00:00:00.000Z';

function entry(ordinal: number, content: string): TranscriptMessage {
	return {
		ordinal,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function page(
	transcriptViewId: string,
	messages: TranscriptMessage[],
	lastOrdinal = messages.at(-1)?.ordinal ?? 0,
): TranscriptPage {
	return {
		transcriptViewId,
		messages,
		lastOrdinal,
		pageOldestOrdinal: messages[0]?.ordinal ?? 0,
		pageNewestOrdinal: lastOrdinal,
		hasMore: false,
	};
}

function contents(messages: TranscriptMessage[]): string[] {
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
		const applied = cache.applyMessages('chat-1', 'generation-1', {
			firstOrdinal: 2,
			lastOrdinal: 2,
			messages: [entry(2, 'two')],
		});

		expect(applied).toEqual({ status: 'applied', changed: true, lastOrdinal: 2 });
		expect(cache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([1, 2]);
		expect(storage.restore('chat-1')).toBeNull();

		cache.flush();
		expect(storage.restore('chat-1')?.entries.map((item) => item.ordinal)).toEqual([1, 2]);
	});

	it('hydrates from storage when memory does not have an entry', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [entry(1, 'one')], { transcriptViewId: 'generation-1', lastOrdinal: 1 });
		const cache = new ChatTranscriptCache({ limit: 100, storage });

		expect(cache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([1]);
	});

	it('allows live creation only when the first batch starts at ordinal 1', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });

		const created = cache.applyMessages('chat-1', 'generation-1', {
			firstOrdinal: 1,
			lastOrdinal: 1,
			messages: [entry(1, 'one')],
		});
		const missingBase = cache.applyMessages('chat-2', 'generation-1', {
			firstOrdinal: 4,
			lastOrdinal: 4,
			messages: [entry(4, 'tail')],
		});

		expect(created.status).toBe('applied');
		expect(contents(cache.get('chat-1')?.messages ?? [])).toEqual(['one']);
		expect(missingBase.status).toBe('missing-base');
		expect(cache.get('chat-2')).toBeNull();
	});

	it('marks transcripts stale on generation mismatch', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		const result = cache.applyMessages('chat-1', 'generation-2', {
			firstOrdinal: 2,
			lastOrdinal: 2,
			messages: [entry(2, 'two')],
		});

		expect(result.status).toBe('view-changed');
		expect(cache.get('chat-1')?.stale).toBe(true);
	});

	it('detects ordinal gaps without advancing the cursor', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		const result = cache.applyMessages('chat-1', 'generation-1', {
			firstOrdinal: 3,
			lastOrdinal: 3,
			messages: [entry(3, 'three')],
		});

		expect(result).toEqual({
			status: 'gap-detected',
			expectedOrdinal: 2,
			receivedOrdinal: 3,
		});
		expect(cache.get('chat-1')?.lastOrdinal).toBe(1);
		expect(cache.get('chat-1')?.stale).toBe(true);
	});

	it('advances the cursor across hidden ledger rows', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		const result = cache.applyMessages('chat-1', 'generation-1', {
			firstOrdinal: 2,
			lastOrdinal: 3,
			messages: [entry(2, 'two')],
		});

		expect(result).toEqual({ status: 'applied', changed: true, lastOrdinal: 3 });
		expect(cache.get('chat-1')?.lastOrdinal).toBe(3);
	});

	it('lists memory cursors before persisted fallback cursors', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('persisted', [entry(1, 'persisted')], {
			transcriptViewId: 'generation-persisted',
			lastOrdinal: 1,
		});
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.replaceFromPage('memory', page('generation-memory', [entry(1, 'memory')]));

		expect(cache.listCursors()).toEqual([
			{ chatId: 'memory', transcriptViewId: 'generation-memory', lastOrdinal: 1 },
			{ chatId: 'persisted', transcriptViewId: 'generation-persisted', lastOrdinal: 1 },
		]);
	});

	it('cancels a pending cache write when a persisted transcript becomes stale', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [entry(1, 'persisted')], {
			transcriptViewId: 'generation-1',
			lastOrdinal: 1,
		});
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.replaceFromPage(
			'chat-1',
			page('generation-1', [entry(1, 'persisted'), entry(2, 'pending')]),
		);

		cache.markStale('chat-1');
		cache.flush();

		expect(storage.restore('chat-1')).toMatchObject({
			entries: [entry(1, 'persisted')],
			stale: true,
		});
		expect(cache.listCursors()).toEqual([]);
	});

	it('does not persist the first cache draft after its transcript becomes stale', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'pending')]));

		cache.markStale('chat-1');
		cache.flush();

		expect(storage.restore('chat-1')).toBeNull();
		expect(cache.listCursors()).toEqual([]);
	});

	it('does not fall through stale memory to a contradictory persisted cursor', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [entry(1, 'persisted')], {
			transcriptViewId: 'generation-1',
			lastOrdinal: 1,
		});
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.get('chat-1');
		cache.markStale('chat-1');
		storage.markValidated('chat-1');

		expect(storage.listCursors()).toHaveLength(1);
		expect(cache.listCursors()).toEqual([]);
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
