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
	it('retains a resumable recent tail from a wide interval through hydration', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 50, storage });
		const entries = Array.from({ length: 650 }, (_, i) => entry(i + 1, 'synthetic'));
		cache.replaceFromPage('wide', page('view', entries));
		expect(cache.get('wide')).toMatchObject({ messages: entries.slice(-50), nextBeforeOrdinal: 601 });
		cache.flush();
		const restored = new ChatTranscriptCache({ limit: 50, storage }).hydrate('wide');
		expect(restored).toMatchObject({ messages: entries.slice(-50), nextBeforeOrdinal: 601, lastOrdinal: 650 });
	});

	beforeEach(() => {
		localStorage.clear();
	});

	it('invalidates persisted tails, evicted drafts, and snapshot reads outside the visible set', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 1, storage });
		cache.replaceFromPage('disk', page('view', [entry(1, 'disk')]));
		cache.flush();
		cache.replaceFromPage('draft', page('view', [entry(1, 'draft')]));
		cache.replaceFromPage('visible', page('view', [entry(1, 'visible')]));
		const diskRead = cache.trackSnapshotRead('disk');
		const coldRead = cache.trackSnapshotRead('cold');
		const visibleRead = cache.trackSnapshotRead('visible');
		cache.markStaleExcept(new Set(['visible']));
		cache.flush();
		expect(storage.restore('disk')?.stale).toBe(true);
		expect(storage.restore('draft')).toBeNull();
		expect(storage.restore('visible')?.stale).toBe(false);
		expect(diskRead.isCurrent()).toBe(false);
		expect(coldRead.isCurrent()).toBe(false);
		expect(visibleRead.isCurrent()).toBe(true);
		for (const read of [diskRead, coldRead, visibleRead]) read.release();
	});

	it('keeps stale tails stale through duplicate, empty, hidden, and contiguous appends', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.replaceFromPage('chat', page('view', [entry(1, 'one')]));
		cache.flush();
		cache.markStale('chat');
		for (const append of [
			{ firstOrdinal: 1, lastOrdinal: 1, messages: [entry(1, 'one')] },
			{ firstOrdinal: 2, lastOrdinal: 1, messages: [] },
			{ firstOrdinal: 2, lastOrdinal: 2, messages: [] },
			{ firstOrdinal: 3, lastOrdinal: 3, messages: [entry(3, 'three')] },
		]) {
			expect(cache.applyMessages('chat', 'view', append).status).toBe('applied');
			expect(cache.get('chat')?.stale).toBe(true);
			cache.flush();
			expect(storage.restore('chat')).toMatchObject({ lastOrdinal: 1, stale: true });
		}
		cache.markValidated('chat');
		cache.flush();
		expect(storage.restore('chat')).toMatchObject({ lastOrdinal: 3, stale: false });
	});

	it('fences validation attempts on a later continuity failure', () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat', page('view', [entry(1, 'one')]));
		const validation = cache.trackReplayValidation('chat');
		const snapshot = cache.trackSnapshotRead('chat');
		cache.markStale('chat');
		expect(validation.isCurrent()).toBe(false);
		expect(snapshot.isCurrent()).toBe(true);
		cache.invalidateSnapshotReads('chat');
		expect(snapshot.isCurrent()).toBe(false);
		snapshot.release();
		validation.release();
		cache.flush();
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
			nextBeforeOrdinal: null,
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
			nextBeforeOrdinal: null,
			lastOrdinal: 1,
		});
		const cache = new ChatTranscriptCache({ limit: 100, storage });
		cache.hydrate('chat-1');
		cache.markStale('chat-1');
		storage.persist('chat-1', [entry(1, 'persisted')], {
			transcriptViewId: 'generation-1', nextBeforeOrdinal: null, lastOrdinal: 1,
		});

		expect(storage.listCursors()).toHaveLength(1);
		expect(cache.listCursors()).toEqual([]);
	});

	it('prunes hidden entries after their budget is exceeded', () => {
		const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 2 });

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
			const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 2 });
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

	it('evicts hidden chats before visible chats and releases protection with visibility', () => {
		const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 2 });
		cache.setMountedChatIds(['visible']);
		cache.replaceFromPage('visible', page('view', [entry(1, 'visible')]));
		cache.replaceFromPage('hidden-old', page('view', [entry(1, 'old')]));
		cache.replaceFromPage('hidden-middle', page('view', [entry(1, 'middle')]));
		cache.replaceFromPage('hidden-new', page('view', [entry(1, 'new')]));
		expect(cache.get('visible')).not.toBeNull();
		expect(cache.get('hidden-old')).toBeNull();
		expect(cache.get('hidden-middle')).not.toBeNull();
		expect(cache.get('hidden-new')).not.toBeNull();

		cache.setMountedChatIds([]);
		expect(cache.get('visible')).toBeNull();
		cache.flush();
	});

	it('bounds hidden entries independently of visible chats and prunes on release', () => {
		const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 1 });
		cache.setMountedChatIds(['chat-1', 'chat-2']);
		cache.replaceFromPage('chat-1', page('view', [entry(1, 'one')]));
		cache.replaceFromPage('chat-2', page('view', [entry(1, 'two')]));
		expect(cache.get('chat-1')).not.toBeNull();
		expect(cache.get('chat-2')).not.toBeNull();

		cache.setMountedChatIds(['chat-1']);
		expect(cache.get('chat-1')).not.toBeNull();
		expect(cache.get('chat-2')).not.toBeNull();
		cache.setMountedChatIds([]);
		expect(cache.get('chat-1')).toBeNull();
		expect(cache.get('chat-2')).not.toBeNull();
		cache.flush();
	});

	it('keeps consecutive hidden pages and appends current before persistence with visible chats pinned', () => {
		const storage = new LocalChatTranscriptStorage();
		const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 1, storage });
		cache.replaceFromPage('hidden', {
			...page('view', [entry(2, 'two')]),
			nextBeforeOrdinal: 2,
			hasMore: true,
		});
		cache.flush();
		cache.setMountedChatIds(['visible']);
		cache.replaceFromPage('visible', page('view', [entry(1, 'visible')]));
		cache.replaceFromPage('other-hidden', page('view', [entry(1, 'other')]));

		expect(cache.get('hidden')).toBeNull();
		cache.applyEarlierPage('hidden', 'view', 2, {
			...page('view', [entry(1, 'one')]),
			lastOrdinal: 2,
		});
		for (const ordinal of [3, 4]) {
			expect(
				cache.applyMessages('hidden', 'view', {
					firstOrdinal: ordinal,
					lastOrdinal: ordinal,
					messages: [entry(ordinal, `message-${ordinal}`)],
				}),
			).toMatchObject({ status: 'applied', lastOrdinal: ordinal });
		}
		cache.flush();
		const restored = storage.restore('hidden');
		expect(restored?.entries.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3, 4]);
		expect(restored?.nextBeforeOrdinal).toBeNull();
		expect(cache.get('hidden')?.lastOrdinal).toBe(4);
		expect(cache.get('other-hidden')).toBeNull();
		expect(cache.get('visible')?.lastOrdinal).toBe(1);
	});

	it('still invalidates and removes protected entries without losing their visibility', () => {
		const cache = new ChatTranscriptCache({ limit: 100, maxHiddenEntries: 1 });
		cache.setMountedChatIds(['visible']);
		cache.replaceFromPage('visible', page('old-view', [entry(1, 'old')]));
		cache.markStale('visible');
		expect(cache.get('visible')?.stale).toBe(true);
		cache.remove('visible');
		expect(cache.get('visible')).toBeNull();
		cache.replaceFromPage('visible', page('new-view', [entry(1, 'new')]));
		cache.replaceFromPage('hidden', page('view', [entry(1, 'hidden')]));
		cache.applyMessages('other-hidden', 'view', {
			firstOrdinal: 1,
			lastOrdinal: 1,
			messages: [entry(1, 'hidden')],
		});
		expect(cache.get('visible')?.transcriptViewId).toBe('new-view');
		expect(cache.get('hidden')).toBeNull();
		cache.flush();
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
			expect(cache.listCursors()).toEqual([{ chatId: 'chat-1', transcriptViewId: 'generation-1', lastOrdinal: 300 }]);
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
