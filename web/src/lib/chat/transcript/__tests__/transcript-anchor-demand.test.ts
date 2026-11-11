import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import {
	parseTranscriptAnchorResponse,
	type TranscriptAnchorPage,
	type TranscriptAnchorRequest,
} from '$shared/transcript-anchor-page';
import { ApiError } from '$lib/api/client.js';
import {
	countTranscriptAnchors,
	loadTranscriptAnchorChunk,
	loadTranscriptAnchorSnapshot,
} from '../transcript-anchor-demand.js';

const time = '2026-01-01T00:00:00.000Z';
const request: TranscriptAnchorRequest = {
	chatId: 'synthetic-chat',
	direction: 'backward',
	anchorsRemaining: 100,
};
function chunk(overrides: Partial<TranscriptAnchorPage> = {}): TranscriptAnchorPage {
	return {
		chatId: request.chatId,
		transcriptViewId: 'synthetic-view',
		direction: 'backward',
		historyState: { kind: 'complete' },
		watermarkOrdinal: 1000,
		lastOrdinal: 1000,
		startOrdinal: 801,
		endOrdinal: 1001,
		anchorsRemaining: 99,
		pageStatus: 'partial',
		messages: [{ ordinal: 1000, message: new AssistantMessage(time, 'Synthetic answer') }],
		resendCandidates: [],
		...overrides,
	};
}

function pages(...responses: TranscriptAnchorPage[]) {
	return vi.fn(async (input: TranscriptAnchorRequest) => {
		const response = responses.shift();
		if (!response) throw new Error('Unexpected combined-history request');
		return parseTranscriptAnchorResponse(input, JSON.parse(JSON.stringify(response)));
	});
}

describe('anchor first-install demand', () => {
	it('installs a wide terminal response whole without coalescing another request', async () => {
		const page = chunk({ startOrdinal: 1, pageStatus: 'exhausted', messages: [
			...Array.from({ length: 999 }, (_, i) => ({ ordinal: i + 1, message: new BashToolUseMessage(time, `tool-${i}`, 'true') })),
			{ ordinal: 1000, message: new AssistantMessage(time, 'answer') },
		] });
		const loadPage = vi.fn(async () => page);
		const result = await loadTranscriptAnchorSnapshot({ request, isCurrent: () => true, loadPage, isDisjoint: () => true });
		expect(result).toMatchObject({ kind: 'complete', page: { messages: page.messages }, finalChunk: { pageStatus: 'exhausted' } });
		expect(loadPage).toHaveBeenCalledTimes(1);
	});

	it('counts the entire hidden prefix for disjoint coalescing without stopping hidden-only progress', async () => {
		const loadPage = vi.fn()
			.mockResolvedValueOnce(chunk({ startOrdinal: 400, messages: [], anchorsRemaining: 100 }))
			.mockResolvedValueOnce(chunk({ startOrdinal: 399, endOrdinal: 400,
				messages: [{ ordinal: 399, message: new AssistantMessage(time, 'answer') }] }));
		const result = await loadTranscriptAnchorSnapshot({ request, isCurrent: () => true, loadPage, isDisjoint: () => true });
		expect(result).toMatchObject({ kind: 'complete', page: { nextBeforeOrdinal: 399, lastOrdinal: 1000 } });
		expect(loadPage).toHaveBeenCalledTimes(2);
	});
	it('resolves after first public chunk rather than accumulating the logical demand', async () => {
		const loadPage = pages(chunk());
		const result = await loadTranscriptAnchorSnapshot({ request, isCurrent: () => true, loadPage });
		expect(result.kind).toBe('complete');
		expect(loadPage).toHaveBeenCalledTimes(1);
	});

	it.each(['backward', 'forward'] as const)(
		'accumulates hidden-only %s navigation and preserves first metadata',
		async (direction) => {
			const backward = direction === 'backward';
			const first = chunk({
				direction,
				startOrdinal: backward ? 801 : 1,
				endOrdinal: backward ? 1001 : 201,
				messages: [],
				anchorsRemaining: 100,
				resendCandidates: backward ? [{ ordinal: 600, content: 'Synthetic pending input', attachmentNames: [] }] : [],
			});
			const second = chunk({
				direction,
				startOrdinal: backward ? 601 : 201,
				endOrdinal: backward ? 801 : 401,
				lastOrdinal: 1001,
				messages: [
					{
						ordinal: backward ? 800 : 201,
						message: new AssistantMessage(time, 'Synthetic answer'),
					},
				],
			});
			const loadPage = pages(first, second);
			const result = await loadTranscriptAnchorSnapshot({
				request: { ...request, direction },
				isCurrent: () => true,
				loadPage,
			});
			expect(result).toMatchObject({
				kind: 'complete',
				page: { lastOrdinal: 1000, messages: second.messages, resendCandidates: first.resendCandidates,
					pageNewestOrdinal: backward ? 1000 : 400, nextBeforeOrdinal: backward ? 601 : null },
				finalChunk: second,
			});
			expect(loadPage.mock.calls[1]?.[0]).toEqual({
				chatId: request.chatId,
				transcriptViewId: 'synthetic-view',
				direction,
				watermarkOrdinal: 1000,
				anchorsRemaining: 100,
				cursorOrdinal: backward ? 801 : 200,
			});
		},
	);

	it('bridges a small public disjoint chunk before installing', async () => {
		const loadPage = pages(
			chunk({ startOrdinal: 1000 }),
			chunk({ startOrdinal: 800, endOrdinal: 1000, messages: [], lastOrdinal: 1005 }),
		);
		const result = await loadTranscriptAnchorSnapshot({
			request,
			isCurrent: () => true,
			loadPage,
			isDisjoint: (page) => (page.nextBeforeOrdinal ?? 1) > 900,
		});
		expect(result).toMatchObject({
			kind: 'complete',
			page: { nextBeforeOrdinal: 800, pageNewestOrdinal: 1000, lastOrdinal: 1000 },
		});
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it('stops disjoint coalescing at its local span target and installs all-hidden terminal history', async () => {
		const loadPage = pages(chunk());
		await loadTranscriptAnchorSnapshot({
			request,
			isCurrent: () => true,
			loadPage,
			isDisjoint: () => true,
		});
		expect(loadPage).toHaveBeenCalledTimes(1);
		const empty = chunk({
			startOrdinal: 1,
			endOrdinal: 1,
			lastOrdinal: 0,
			watermarkOrdinal: 0,
			messages: [],
			pageStatus: 'exhausted',
			anchorsRemaining: 100,
		});
		expect(
			await loadTranscriptAnchorSnapshot({
				request,
				isCurrent: () => true,
				loadPage: pages(empty),
			}),
		).toMatchObject({
			kind: 'complete',
			page: { messages: [], pageNewestOrdinal: 0, nextBeforeOrdinal: null },
		});
	});

	it.each(['success', 'TRANSCRIPT_CURSOR_AHEAD', 'STALE_TRANSCRIPT_VIEW', 'network'] as const)(
		'discards a %s response when superseded during transport', async outcome => {
			const response = Promise.withResolvers<TranscriptAnchorPage>();
			const loadPage = vi.fn(() => response.promise);
			let current = true;
			const pending = loadTranscriptAnchorChunk(request, () => current, { loadPage });
			expect(loadPage).toHaveBeenCalledExactlyOnceWith(request);
			current = false;
			if (outcome === 'success') response.resolve(chunk());
			else if (outcome === 'network') response.reject(new Error('Synthetic network failure'));
			else response.reject(new ApiError(409, 'Synthetic conflict', outcome));
			expect(await pending).toEqual({ kind: 'invalidated' });
		},
	);

	it('subtracts only canonical anchors strictly below the fetched start', () => {
		const entries: TranscriptMessage[] = [
			{ ordinal: 1, message: new UserMessage(time, 'Synthetic input') },
			{ ordinal: 2, message: new BashToolUseMessage(time, 'synthetic-tool', 'true') },
			{ ordinal: 3, message: new AssistantMessage(time, 'Synthetic answer') },
			{ ordinal: 4, message: new UserMessage(time, 'Synthetic live input') },
		];
		expect(countTranscriptAnchors(entries, 3)).toBe(1);
		expect(countTranscriptAnchors(entries)).toBe(3);
	});
});
