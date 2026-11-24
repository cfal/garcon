import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte.js';
import type { TranscriptHeadReadResult, TranscriptHeadResult } from '../transcript-head-coordinator.js';

const request = { combinedMode: false, knownHeads: [] };
const caches: ChatTranscriptCache[] = [];
function fixture() {
	const cache = new ChatTranscriptCache({ limit: 10, maxHiddenEntries: 0 });
	caches.push(cache);
	cache.setMountedChatIds(['chat']);
	return cache;
}
function page(viewId: string, lastOrdinal = 1) {
	return { transcriptViewId: viewId, lastOrdinal, pageOldestOrdinal: lastOrdinal ? 1 : 0,
		pageNewestOrdinal: lastOrdinal, nextBeforeOrdinal: null, hasMore: false,
		messages: Array.from({ length: lastOrdinal }, (_, index) => ({ ordinal: index + 1,
			message: new AssistantMessage('2026-01-01T00:00:00.000Z', `Synthetic row ${index + 1}`) })) };
}
afterEach(() => {
	for (const cache of caches.splice(0)) cache.remove('chat');
	localStorage.clear();
});

describe('chat-owned head reads', () => {
	it('shares a read across consumers and preserves live rows after cache eviction', async () => {
		const cache = fixture();
		const held = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValue(held.promise);
		const first = cache.headReads.load('chat', request);
		const peer = cache.headReads.load('chat', request);
		expect(peer).toBe(first);
		cache.applyMessages('chat', 'a', { firstOrdinal: 2, lastOrdinal: 2, messages: page('a', 2).messages.slice(1) });
		cache.setMountedChatIds([]);
		held.resolve({ kind: 'complete', page: page('a') });
		expect(await first).toMatchObject({ kind: 'complete', page: { pageNewestOrdinal: 2 } });
		expect(read).toHaveBeenCalledOnce();
		expect(cache.needsSnapshotRecovery('chat')).toBe(false);
		expect(cache.acceptedView('chat')).toBe('a');
	});

	it.each(['resolve', 'reject'] as const)('fences deletion before a read can %s', async outcome => {
		const cache = fixture();
		const held = Promise.withResolvers<TranscriptHeadReadResult>();
		vi.spyOn(cache.headReads, 'read').mockReturnValue(held.promise);
		const loading = cache.headReads.load('chat', request);
		cache.remove('chat');
		if (outcome === 'resolve') held.resolve({ kind: 'complete', page: page('a') });
		else held.reject(new Error('Synthetic late failure'));
		expect(await loading).toEqual({ kind: 'invalidated' });
		expect(cache.get('chat')).toBeNull();
		expect(cache.acceptedView('chat')).toBeNull();
		expect(cache.headReads.pending('chat')).toBeUndefined();
	});

	it('queues a different display mode rather than treating its window as covered', async () => {
		const cache = fixture();
		const held = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValueOnce(held.promise)
			.mockResolvedValue({ kind: 'complete', page: page('a') });
		const raw = cache.headReads.load('chat', request);
		const combined = cache.headReads.load('chat', { ...request, combinedMode: true });
		expect(read).toHaveBeenCalledOnce();
		held.resolve({ kind: 'complete', page: page('a') });
		await raw;
		expect(await combined).toMatchObject({ kind: 'complete' });
		expect(read).toHaveBeenCalledTimes(2);
		expect(read.mock.calls[1]?.[1].combinedMode).toBe(true);
	});

	it('retains missed debt across replacement and rejects the retired response', async () => {
		const cache = fixture();
		cache.replaceFromPage('chat', page('a'));
		const old = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValueOnce(old.promise)
			.mockResolvedValue({ kind: 'complete', page: page('b', 2) });
		const retired = cache.headReads.load('chat', request);
		cache.announceReplacement('chat', 'b', 'a');
		cache.applyMessages('chat', 'b', { firstOrdinal: 2, lastOrdinal: 2, messages: page('b', 2).messages.slice(1) });
		const replacement = cache.headReads.load('chat', request);
		expect(await replacement).toMatchObject({ kind: 'complete' });
		old.resolve({ kind: 'complete', page: page('a', 3) });
		expect(await retired).toEqual({ kind: 'invalidated' });
		expect(read).toHaveBeenCalledTimes(2);
		expect(cache.readAppliedCursor('chat')).toEqual({ transcriptViewId: 'b', lastOrdinal: 2, stale: false });
	});

	it('stops after one follow-up without certifying an uncovered frontier', async () => {
		const cache = fixture();
		cache.replaceFromPage('chat', page('a'));
		cache.applyMessages('chat', 'a', { firstOrdinal: 3, lastOrdinal: 3, messages: page('a', 3).messages.slice(2) });
		const read = vi.spyOn(cache.headReads, 'read').mockResolvedValue({ kind: 'complete', page: page('a', 2) });
		expect(await cache.headReads.load('chat', request)).toEqual({ kind: 'incomplete' });
		expect(read).toHaveBeenCalledTimes(2);
		expect(cache.readAppliedCursor('chat')).toMatchObject({ lastOrdinal: 2, stale: true });
		expect(cache.needsSnapshotRecovery('chat')).toBe(true);
		expect(cache.headReads.pending('chat')).toBeUndefined();
	});

	it('retries instead of replacing a disjoint newer window accepted by navigation', async () => {
		const cache = fixture();
		cache.replaceFromPage('chat', page('a', 50));
		const held = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValueOnce(held.promise)
			.mockResolvedValue({ kind: 'complete', page: page('a', 200) });
		const loading = cache.headReads.load('chat', request);
		cache.replaceFromPage('chat', page('a', 200));
		held.resolve({ kind: 'complete', page: page('a', 100) });
		expect(await loading).toMatchObject({ kind: 'complete', page: { pageNewestOrdinal: 200 } });
		expect(read).toHaveBeenCalledTimes(2);
		expect(cache.readAppliedCursor('chat')).toEqual({ transcriptViewId: 'a', lastOrdinal: 200, stale: false });
	});

	it('retires buffered commits when a confirmed cursor reset renews the read lease', async () => {
		const cache = fixture();
		cache.replaceFromPage('chat', page('a', 2));
		const held = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValueOnce(held.promise)
			.mockResolvedValue({ kind: 'complete', page: page('a') });
		const loading = cache.headReads.load('chat', { ...request, combinedMode: true });
		cache.applyMessages('chat', 'a', { firstOrdinal: 2, lastOrdinal: 2, messages: page('a', 2).messages.slice(1) });
		held.resolve({ kind: 'cursor-ahead', transcriptViewId: 'a' });
		expect(await loading).toMatchObject({ kind: 'complete', page: { pageNewestOrdinal: 1 } });
		expect(read).toHaveBeenCalledTimes(2);
		expect(cache.readAppliedCursor('chat')).toEqual({ transcriptViewId: 'a', lastOrdinal: 1, stale: false });
	});

	it('queues an explicit refresh after the invalidated final attempt instead of losing demand', async () => {
		const cache = fixture();
		cache.replaceFromPage('chat', page('a', 3));
		const first = Promise.withResolvers<TranscriptHeadReadResult>();
		const followUp = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(followUp.promise).mockResolvedValue({ kind: 'complete', page: page('a', 9) });
		const activation = cache.headReads.load('chat', request);
		cache.applyMessages('chat', 'a', { firstOrdinal: 6, lastOrdinal: 6, messages: page('a', 6).messages.slice(5) });
		first.resolve({ kind: 'complete', page: page('a', 3) });
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
		cache.invalidateSnapshotReads('chat');
		const refresh = cache.headReads.load('chat', request);
		followUp.resolve({ kind: 'complete', page: page('a', 9) });
		expect(await activation).toEqual({ kind: 'incomplete' });
		expect(await refresh).toMatchObject({ kind: 'complete' });
		expect(read).toHaveBeenCalledTimes(3);
		expect(cache.readAppliedCursor('chat')).toEqual({ transcriptViewId: 'a', lastOrdinal: 9, stale: false });
	});

	it('queues the reset presentation demand when cursor repair exhausts the current operation', async () => {
		const cache = fixture();
		cache.replaceFromPage('chat', page('a', 3));
		const first = Promise.withResolvers<TranscriptHeadReadResult>();
		const read = vi.spyOn(cache.headReads, 'read').mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce({ kind: 'cursor-ahead', transcriptViewId: 'a' })
			.mockResolvedValue({ kind: 'complete', page: page('a', 2) });
		const rejoined: Promise<TranscriptHeadResult>[] = [];
		cache.headReads.onPublication((chatId, publication) => {
			if (publication.kind === 'cursor-reset') rejoined.push(cache.headReads.load(chatId, request));
		});
		const loading = cache.headReads.load('chat', request);
		cache.invalidateSnapshotReads('chat');
		first.resolve({ kind: 'complete', page: page('a', 3) });
		expect(await loading).toEqual({ kind: 'incomplete' });
		expect(await rejoined[0]).toMatchObject({ kind: 'complete' });
		expect(read).toHaveBeenCalledTimes(3);
		expect(cache.readAppliedCursor('chat')).toEqual({ transcriptViewId: 'a', lastOrdinal: 2, stale: false });
	});
});
