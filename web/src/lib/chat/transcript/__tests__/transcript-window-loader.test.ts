import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { stageLatestTranscriptWindow } from '../transcript-window-loader.js';

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

	it('stages a wide suffix while same-generation live messages extend the tail', async () => {
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce(page('generation-1', 51, 200, 250, 200))
			.mockResolvedValueOnce(page('generation-1', 1, 50, 251, 50));

		const staged = await stageLatestTranscriptWindow('chat-1', 250);

		expect(staged).not.toBe('snapshot-changed');
		if (staged === 'snapshot-changed') return;
		expect(staged.messages.map((entry) => entry.seq)).toEqual(
			Array.from({ length: 250 }, (_, index) => index + 1),
		);
		expect(staged.lastSeq).toBe(250);
		expect(getChatMessages).toHaveBeenNthCalledWith(2, {
			chatId: 'chat-1',
			limit: 50,
			beforeSeq: 51,
		});
	});

	it('rejects pages from a replacement generation', async () => {
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce(page('generation-1', 51, 200, 250, 200))
			.mockResolvedValueOnce(page('generation-2', 1, 50, 250, 50));

		await expect(stageLatestTranscriptWindow('chat-1', 250)).resolves.toBe('snapshot-changed');
	});
});
