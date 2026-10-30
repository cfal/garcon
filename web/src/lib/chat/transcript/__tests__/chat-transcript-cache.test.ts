import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { LocalChatTranscriptStorage } from '$lib/chat/transcript/chat-transcript-storage.js';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage, TranscriptPage } from '$shared/chat-view';
import ChatTranscriptCacheDerivedReaderTestHost from './ChatTranscriptCacheDerivedReaderTestHost.svelte';
import * as lifetime from '$lib/utils/browser-data-lifetime';

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
		nextBeforeOrdinal: null,
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
		storage.persist('chat-1', [entry(1, 'one')], { transcriptViewId: 'generation-1', nextBeforeOrdinal: null, lastOrdinal: 1 });
		const cache = new ChatTranscriptCache({ limit: 100, storage });

		expect(cache.get('chat-1')).toBeNull();
		expect(cache.hydrate('chat-1')?.messages.map((item) => item.ordinal)).toEqual([1]);
		expect(cache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([1]);
	});

	it('[TLV5-PAGE.09-WEB-STORAGE-01] hydrates the raw earlier continuation independently of visible rows', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 50, storage });
		const boundedTail = Array.from({ length: 50 }, (_, index) =>
			entry(index + 251, `message-${index + 251}`),
		);
		const pageAfterHiddenScan = {
			...page('generation-1', boundedTail, 300),
			hasMore: true,
			nextBeforeOrdinal: 201,
		};

		cache.replaceFromPage('chat-1', pageAfterHiddenScan);
		expect(cache.get('chat-1')).toMatchObject({
			oldestOrdinal: 251,
			nextBeforeOrdinal: 201,
		});

		cache.flush();
		const hydrated = new ChatTranscriptCache({ limit: 50, storage }).hydrate('chat-1');
		expect(hydrated).toMatchObject({
			oldestOrdinal: 251,
			nextBeforeOrdinal: 201,
		});
		expect(hydrated?.messages.map((item) => item.ordinal)).toEqual(
			Array.from({ length: 50 }, (_, index) => index + 251),
		);
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

	it('[TLV5-REPLAY.09-WEB-UNIT-01] discards a gapped batch and keeps the contiguous prefix resumable', () => {
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
		expect(cache.get('chat-1')?.messages.map((item) => item.ordinal)).toEqual([1]);
		expect(cache.readAppliedCursor('chat-1')).toEqual({
			transcriptViewId: 'generation-1',
			lastOrdinal: 1,
			stale: false,
		});
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

	it('cancels a pending cache write when a persisted transcript becomes stale', () => {
		const storage = new LocalChatTranscriptStorage();
		storage.persist('chat-1', [entry(1, 'persisted')], {
			transcriptViewId: 'generation-1',
			nextBeforeOrdinal: null,
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
		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(true);
	});

	it('does not persist the first cache draft after its transcript becomes stale', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'pending')]));

		cache.markStale('chat-1');
		cache.flush();

		expect(storage.restore('chat-1')).toBeNull();
		expect(cache.readAppliedCursor('chat-1')?.stale).toBe(true);
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

	it('uses explicit access recency when pruning memory entries', () => {
		vi.useFakeTimers();
		try {
			const cache = new ChatTranscriptCache({ limit: 100, maxEntries: 2 });
			vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
			cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
			vi.setSystemTime(new Date('2024-01-01T00:00:01.000Z'));
			cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'two')]));
			vi.setSystemTime(new Date('2024-01-01T00:00:02.000Z'));
			cache.markAccessed('chat-1');
			vi.setSystemTime(new Date('2024-01-01T00:00:03.000Z'));
			cache.replaceFromPage('chat-3', page('generation-3', [entry(1, 'three')]));

			expect(cache.get('chat-1')).not.toBeNull();
			expect(cache.get('chat-2')).toBeNull();
			expect(cache.get('chat-3')).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('reads reactive entries without mutating cache state during derivation', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));

		render(ChatTranscriptCacheDerivedReaderTestHost, { cache, chatId: 'chat-1' });
		expect(screen.getByTestId('cached-last-ordinal').textContent).toBe('1');

		cache.replaceFromPage(
			'chat-1',
			page('generation-1', [entry(1, 'one'), entry(2, 'two')]),
		);
		await waitFor(() => {
			expect(screen.getByTestId('cached-last-ordinal').textContent).toBe('2');
		});
	});

	describe('paced persistence', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => {
			vi.useRealTimers();
			vi.restoreAllMocks();
		});

		it('yields between chats and persists the latest pending draft only once per cycle', () => {
			const storage = new LocalChatTranscriptStorage();
			const persist = vi.spyOn(storage, 'persist');
			const cache = new ChatTranscriptCache({ limit: 100, storage });
			cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
			cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'two')]));
			vi.advanceTimersByTime(799);
			expect(persist).not.toHaveBeenCalled();
			vi.advanceTimersToNextTimer();
			expect(persist.mock.calls.map(([id]) => id)).toEqual(['chat-1']);

			cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'updated one')]));
			cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'updated two')]));
			vi.advanceTimersToNextTimer();
			expect(persist.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-2']);
			expect(storage.restore('chat-2')?.entries).toEqual([entry(1, 'updated two')]);
			vi.advanceTimersByTime(799);
			expect(persist).toHaveBeenCalledTimes(2);
			vi.advanceTimersByTime(1);
			expect(persist.mock.calls.map(([id]) => id)).toEqual(['chat-1', 'chat-2', 'chat-1']);
			expect(storage.restore('chat-1')?.entries).toEqual([entry(1, 'updated one')]);
		});

		it.each(['markStale', 'remove'] as const)('allows %s to cancel a draft between timer turns', (method) => {
			const storage = new LocalChatTranscriptStorage();
			const persist = vi.spyOn(storage, 'persist');
			const cache = new ChatTranscriptCache({ limit: 100, storage });
			cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
			cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'two')]));
			vi.advanceTimersToNextTimer();
			cache[method]('chat-2');
			vi.runAllTimers();
			expect(persist.mock.calls.map(([id]) => id)).toEqual(['chat-1']);
			expect(storage.restore('chat-2')).toBeNull();
		});

		it('does not validate an old stored view while its replacement is pending', () => {
			const storage = new LocalChatTranscriptStorage();
			storage.persist('chat-1', [entry(1, 'old')], { transcriptViewId: 'old-view', nextBeforeOrdinal: null, lastOrdinal: 1 });
			const cache = new ChatTranscriptCache({ limit: 100, storage });
			cache.markStale('chat-1');
			cache.replaceFromPage('chat-1', page('new-view', [entry(1, 'new')]));
			cache.markValidated('chat-1');
			expect(storage.restore('chat-1')).toMatchObject({ transcriptViewId: 'old-view', stale: true });
			vi.runAllTimers();
			expect(storage.restore('chat-1')).toMatchObject({ transcriptViewId: 'new-view', stale: false });
		});

		it('keeps memory and raw cursors intact when disk admission rejects the snapshot', () => {
			const storage = new LocalChatTranscriptStorage();
			const cache = new ChatTranscriptCache({ limit: 100, storage });
			const messages = [entry(250, 'x'.repeat(300_000))];
			cache.replaceFromPage('chat-1', {
				...page('generation-1', messages, 300), nextBeforeOrdinal: 201, hasMore: true,
			});
			cache.flush();
			expect(storage.restore('chat-1')).toBeNull();
			expect(cache.get('chat-1')).toMatchObject({ messages, lastOrdinal: 300, nextBeforeOrdinal: 201, stale: false });
			expect(cache.readAppliedCursor('chat-1')).toEqual({ transcriptViewId: 'generation-1', lastOrdinal: 300, stale: false });
		});

		it('fences a document retired between timer turns', () => {
			const storage = new LocalChatTranscriptStorage();
			const cache = new ChatTranscriptCache({ limit: 100, storage });
			cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
			cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'two')]));
			vi.advanceTimersToNextTimer();
			const stored = localStorage.getItem('chat_snapshot_chat-1');
			vi.spyOn(lifetime, 'canPersistBrowserData').mockReturnValue(false);
			vi.runAllTimers();
			expect(localStorage.getItem('chat_snapshot_chat-1')).toBe(stored);
			expect(localStorage.getItem('chat_snapshot_chat-2')).toBeNull();
		});

		it('synchronously flushes the remainder and cancels the timer continuation', () => {
			const storage = new LocalChatTranscriptStorage();
			const persist = vi.spyOn(storage, 'persist');
			const cache = new ChatTranscriptCache({ limit: 100, storage });
			cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
			cache.replaceFromPage('chat-2', page('generation-2', [entry(1, 'two')]));
			vi.advanceTimersToNextTimer();
			cache.flush();
			expect(persist).toHaveBeenCalledTimes(2);
			expect(vi.getTimerCount()).toBe(0);
			vi.runAllTimers();
			expect(persist).toHaveBeenCalledTimes(2);
		});
	});
});
