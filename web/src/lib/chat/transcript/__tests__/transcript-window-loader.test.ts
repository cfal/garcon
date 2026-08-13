import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import {
	pruneTranscriptToLatestWindow,
	retainLoadedTranscriptPrefix,
	stageLatestTranscriptWindow,
} from '../transcript-window-loader.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));

const TS = '2026-08-13T00:00:00.000Z';

function page(
	generationId: string,
	startSeq: number,
	count: number,
	lastSeq: number,
	limit: number,
): CompleteChatHistoryResponse {
	return {
		chatId: 'chat-1',
		generationId,
		historyState: { kind: 'complete' },
		limit,
		lastSeq,
		pageOldestSeq: count === 0 ? 0 : startSeq,
		hasMore: count > 0 && startSeq > 1,
		pendingUserInputs: [],
		messages: Array.from({ length: count }, (_, index) => ({
			seq: startSeq + index,
			message: new AssistantMessage(TS, `message-${startSeq + index}`),
		})),
	};
}

describe('stageLatestTranscriptWindow', () => {
	beforeEach(() => vi.clearAllMocks());

	it('bounds latest-window validation to one maximum-size request', async () => {
		vi.mocked(getChatMessages).mockResolvedValueOnce(page('generation-1', 51, 200, 250, 200));

		const staged = await stageLatestTranscriptWindow('chat-1', 7_274);

		expect(staged.messages.map((entry) => entry.seq)).toEqual(
			Array.from({ length: 200 }, (_, index) => index + 51),
		);
		expect(staged.lastSeq).toBe(250);
		expect(getChatMessages).toHaveBeenCalledOnce();
		expect(getChatMessages).toHaveBeenCalledWith({ chatId: 'chat-1', limit: 200 });
	});

	it('retains only an exact contiguous same-generation prefix', () => {
		const latest = page('generation-1', 101, 200, 300, 200);
		const loaded = page('generation-1', 1, 300, 300, 300).messages;
		const retained = retainLoadedTranscriptPrefix('generation-1', loaded, latest);

		expect(retained.messages.map((entry) => entry.seq)).toEqual(
			Array.from({ length: 300 }, (_, index) => index + 1),
		);
		expect(retained.messages[99]).toBe(loaded[99]);
		expect(retained.messages[100]).toBe(latest.messages[0]);
		expect(retained.pageOldestSeq).toBe(1);
		expect(retained.hasMore).toBe(false);
		expect(retainLoadedTranscriptPrefix('generation-2', loaded, latest)).toBe(latest);
		expect(retainLoadedTranscriptPrefix('generation-1', loaded.slice(0, 99), latest)).toBe(latest);
	});

	it('prunes only a contiguous live window to its exact latest suffix', () => {
		const expanded = page('generation-1', 1, 250, 250, 250);

		const pruned = pruneTranscriptToLatestWindow(expanded, 100);

		expect(pruned).toMatchObject({
			generationId: 'generation-1',
			lastSeq: 250,
			pageOldestSeq: 151,
			hasMore: true,
		});
		expect(pruned?.messages.map((entry) => entry.seq)).toEqual(
			Array.from({ length: 100 }, (_, index) => index + 151),
		);
		expect(pruneTranscriptToLatestWindow(page('generation-1', 151, 100, 250, 100), 100)).toBe(null);
		expect(pruneTranscriptToLatestWindow(page('generation-1', 1, 100, 250, 100), 50)).toBe(null);
	});
});
