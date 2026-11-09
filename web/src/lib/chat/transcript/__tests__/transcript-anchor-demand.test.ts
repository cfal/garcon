import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage, BashToolUseMessage, UserMessage } from '$shared/chat-types';
import type { TranscriptMessage } from '$shared/chat-view';
import type { TranscriptAnchorPage, TranscriptAnchorRequest } from '$shared/transcript-anchor-page';
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

describe('anchor first-install demand', () => {
	it('resolves after first public chunk rather than accumulating the logical demand', async () => {
		const loadPage = vi.fn(async () => chunk());
		const result = await loadTranscriptAnchorSnapshot({ request, isCurrent: () => true, loadPage });
		expect(result.kind).toBe('complete');
		expect(loadPage).toHaveBeenCalledTimes(1);
	});

	it.each(['backward', 'forward'] as const)(
		'accumulates hidden-only %s navigation and preserves first metadata',
		async (direction) => {
			const first = chunk({
				direction,
				startOrdinal: 5,
				endOrdinal: 6,
				messages: [],
				anchorsRemaining: 100,
			});
			const second = chunk({
				direction,
				startOrdinal: direction === 'backward' ? 4 : 6,
				endOrdinal: direction === 'backward' ? 5 : 7,
				lastOrdinal: 1001,
				messages: [
					{
						ordinal: direction === 'backward' ? 4 : 6,
						message: new AssistantMessage(time, 'Synthetic answer'),
					},
				],
			});
			const loadPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
			const result = await loadTranscriptAnchorSnapshot({
				request: { ...request, direction },
				isCurrent: () => true,
				loadPage,
			});
			expect(result).toMatchObject({
				kind: 'complete',
				page: { lastOrdinal: 1000, messages: second.messages },
				finalChunk: second,
			});
			expect(loadPage.mock.calls[1]?.[0]).toMatchObject({
				watermarkOrdinal: 1000,
				anchorsRemaining: 100,
				cursorOrdinal: 5,
			});
		},
	);

	it('bridges a small public disjoint chunk before installing', async () => {
		const loadPage = vi
			.fn()
			.mockResolvedValueOnce(chunk({ startOrdinal: 1000 }))
			.mockResolvedValueOnce(
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

	it('stops disjoint accumulation after a full raw chunk and installs all-hidden terminal history', async () => {
		const loadPage = vi.fn(async () => chunk());
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
				loadPage: async () => empty,
			}),
		).toMatchObject({
			kind: 'complete',
			page: { messages: [], pageNewestOrdinal: 0, nextBeforeOrdinal: null },
		});
	});

	it('does not advance or recover a superseded response', async () => {
		const loadPage = vi.fn(async () => {
			throw new ApiError(409, 'Synthetic rollback', 'TRANSCRIPT_CURSOR_AHEAD');
		});
		expect(await loadTranscriptAnchorChunk(request, () => false, { loadPage })).toEqual({
			kind: 'invalidated',
		});
		expect(await loadTranscriptAnchorChunk(request, () => true, { loadPage })).toMatchObject({
			kind: 'cursor-ahead',
		});
	});

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
