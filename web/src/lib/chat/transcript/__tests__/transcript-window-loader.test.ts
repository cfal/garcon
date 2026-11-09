import { describe, expect, it } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatTranscriptSnapshot } from '../chat-transcript-cache.svelte.js';
import { mergeCachedLatestAnchorWindow, type TranscriptWindowPage } from '../transcript-window-loader.js';

const rows = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => ({
	ordinal: first + index,
	message: new AssistantMessage('2026-01-01T00:00:00.000Z', `Synthetic response ${first + index}`),
}));
const page: TranscriptWindowPage = {
	transcriptViewId: 'synthetic-view',
	messages: rows(50, 100),
	lastOrdinal: 105,
	pageOldestOrdinal: 50,
	pageNewestOrdinal: 100,
	nextBeforeOrdinal: 50,
	hasMore: true,
	resendCandidates: [],
};
const cache = (first: number, last = 110): ChatTranscriptSnapshot => ({
	chatId: 'synthetic-chat',
	transcriptViewId: 'synthetic-view',
	messages: rows(first, last),
	oldestOrdinal: first,
	nextBeforeOrdinal: first,
	lastOrdinal: last,
	stale: false,
});

describe('combined Latest cache merge', () => {
	it.each([90, 101])('merges a contiguous tail starting at %i without dropping or duplicating fetched rows', first => {
		const result = mergeCachedLatestAnchorWindow(page, cache(first));
		expect(result.messages).toEqual(rows(50, 110));
		expect(result).toMatchObject({ lastOrdinal: 110, pageNewestOrdinal: 110, pageOldestOrdinal: 50, nextBeforeOrdinal: 50 });
		expect(result.resendCandidates).toBe(page.resendCandidates);
	});

	it.each([
		['gap', cache(102)],
		['stale', { ...cache(90), stale: true }],
		['other view', { ...cache(90), transcriptViewId: 'replacement-view' }],
		['older frontier', cache(90, 99)],
		['same frontier', cache(90, 100)],
		['missing cache', null],
	] as const)('preserves the fetched interval with %s', (_label, cached) => {
		expect(mergeCachedLatestAnchorWindow(page, cached)).toBe(page);
	});
});
