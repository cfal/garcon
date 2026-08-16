import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTranscriptLoader } from '$lib/chat/transcript/background-transcript-loader.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { TranscriptMessage, CompleteChatHistoryResponse } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';

vi.mock('$lib/api/chats.js', () => ({
	getChatMessages: vi.fn(),
}));

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
): CompleteChatHistoryResponse {
	return {
		historyState: { kind: 'complete' },
		chatId: 'chat-1',
		transcriptViewId,
		messages,
		lastOrdinal,
		pageOldestOrdinal: messages[0]?.ordinal ?? 0,
		pageNewestOrdinal: lastOrdinal,
		nextBeforeOrdinal: null,
		hasMore: false,
		resendCandidates: [],
		limit: 100,
	};
}

function seqs(cache: ChatTranscriptCache, chatId = 'chat-1'): number[] {
	return cache.get(chatId)?.messages.map((item) => item.ordinal) ?? [];
}

function boundedNewestPage(
	messages: TranscriptMessage[],
	pageNewestOrdinal: number,
	nextBeforeOrdinal: number | null,
): CompleteChatHistoryResponse {
	return {
		...page('generation-1', messages, 250),
		pageOldestOrdinal: messages[0]?.ordinal ?? 0,
		pageNewestOrdinal,
		nextBeforeOrdinal,
		hasMore: nextBeforeOrdinal !== null,
		limit: 100,
	};
}

describe('BackgroundTranscriptLoader', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(getChatMessages).mockReset();
	});

	it('[TLV5-PAGE.09-WEB-BACKGROUND-01] fills a cached newest snapshot across trailing hidden raw budgets', async () => {
		vi.mocked(getChatMessages)
			.mockResolvedValueOnce(boundedNewestPage([], 250, 151))
			.mockResolvedValueOnce(boundedNewestPage([], 150, 51))
			.mockResolvedValueOnce(
				boundedNewestPage(
					Array.from({ length: 50 }, (_, index) => entry(index + 1, `message-${index + 1}`)),
					50,
					null,
				),
			);
		const cache = new ChatTranscriptCache({ limit: 50 });
		const replaceFromPage = vi.spyOn(cache, 'replaceFromPage');
		const loader = new BackgroundTranscriptLoader({ cache });

		loader.queueLoad('chat-1');
		await loader.waitForIdle('chat-1');

		expect(vi.mocked(getChatMessages).mock.calls.map(([request]) => request)).toEqual([
			{ chatId: 'chat-1', limit: 100 },
			{ chatId: 'chat-1', limit: 100, beforeOrdinal: 151, transcriptViewId: 'generation-1' },
			{ chatId: 'chat-1', limit: 100, beforeOrdinal: 51, transcriptViewId: 'generation-1' },
		]);
		expect(replaceFromPage).toHaveBeenCalledOnce();
		expect(seqs(cache)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
		expect(cache.get('chat-1')).toMatchObject({
			lastOrdinal: 250,
			nextBeforeOrdinal: null,
		});
	});

	it('coalesces repeated loads for the same chat', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		const loadPage = vi.fn().mockResolvedValue(page('generation-1', [entry(1, 'one')]));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });

		loader.queueLoad('chat-1');
		loader.queueLoad('chat-1');
		await loader.waitForIdle('chat-1');

		expect(loadPage).toHaveBeenCalledTimes(1);
		expect(seqs(cache)).toEqual([1]);
	});

	it('applies a held tail batch after loading its base snapshot', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		const loadPage = vi
			.fn()
			.mockResolvedValue(page('generation-1', [entry(1, 'one'), entry(2, 'two')]));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });

		loader.queueLoad('chat-1', {
			transcriptViewId: 'generation-1',
			messages: [entry(3, 'three')],
			firstOrdinal: 3,
			lastOrdinal: 3,
		});
		await loader.waitForIdle('chat-1');

		expect(seqs(cache)).toEqual([1, 2, 3]);
	});

	it('drains tail batches queued while replaying held batches', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		const loadPage = vi
			.fn()
			.mockResolvedValue(page('generation-1', [entry(1, 'one'), entry(2, 'two')]));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });
		const applyMessages = cache.applyMessages.bind(cache);
		let queuedLateBatch = false;
		const applyMessagesSpy = vi
			.spyOn(cache, 'applyMessages')
			.mockImplementation((chatId, transcriptViewId, append) => {
				const result = applyMessages(chatId, transcriptViewId, append);
				if (!queuedLateBatch) {
					queuedLateBatch = true;
					loader.queueLoad('chat-1', {
						transcriptViewId: 'generation-1',
						messages: [entry(4, 'four')],
						firstOrdinal: 4,
						lastOrdinal: 4,
					});
				}
				return result;
			});

		loader.queueLoad('chat-1', {
			transcriptViewId: 'generation-1',
			messages: [entry(3, 'three')],
			firstOrdinal: 3,
			lastOrdinal: 3,
		});
		await loader.waitForIdle('chat-1');

		expect(applyMessagesSpy).toHaveBeenCalledTimes(2);
		expect(seqs(cache)).toEqual([1, 2, 3, 4]);
	});

	it('dispatches a follow-up load for batches queued after the final drain check', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		const loadPage = vi
			.fn()
			.mockResolvedValue(page('generation-1', [entry(1, 'one'), entry(2, 'two')]));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });
		const replaceFromPage = cache.replaceFromPage.bind(cache);
		let queuedAfterDrain = false;
		vi.spyOn(cache, 'replaceFromPage').mockImplementation((chatId, loadedPage) => {
			const result = replaceFromPage(chatId, loadedPage);
			if (!queuedAfterDrain) {
				queuedAfterDrain = true;
				queueMicrotask(() => {
					loader.queueLoad('chat-1', {
						transcriptViewId: 'generation-1',
						messages: [entry(3, 'three')],
						firstOrdinal: 3,
						lastOrdinal: 3,
					});
				});
			}
			return result;
		});

		loader.queueLoad('chat-1');
		await loader.waitForIdle('chat-1');
		await loader.waitForIdle('chat-1');

		expect(loadPage).toHaveBeenCalledTimes(2);
		expect(seqs(cache)).toEqual([1, 2, 3]);
	});

	it('does not tight-loop retry held batches after a snapshot load failure', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
		const loadPage = vi.fn().mockRejectedValue(new Error('network'));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });

		loader.queueLoad('chat-1', {
			transcriptViewId: 'generation-1',
			messages: [entry(2, 'two')],
			firstOrdinal: 2,
			lastOrdinal: 2,
		});
		await loader.waitForIdle('chat-1');
		await Promise.resolve();

		expect(loadPage).toHaveBeenCalledTimes(1);
		expect(seqs(cache)).toEqual([1]);
		expect(cache.get('chat-1')?.stale).toBe(true);
	});

	it('ignores held tail batches from a different generation', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		const loadPage = vi.fn().mockResolvedValue(page('generation-2', [entry(1, 'one')]));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });

		loader.queueLoad('chat-1', {
			transcriptViewId: 'generation-1',
			messages: [entry(2, 'old')],
			firstOrdinal: 2,
			lastOrdinal: 2,
		});
		await loader.waitForIdle('chat-1');

		expect(seqs(cache)).toEqual([1]);
	});

	it('leaves an existing transcript stale when snapshot loading fails', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'one')]));
		const loadPage = vi.fn().mockRejectedValue(new Error('network'));
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });

		loader.queueLoad('chat-1');
		await loader.waitForIdle('chat-1');

		expect(cache.get('chat-1')?.stale).toBe(true);
	});

	it('removes cached and held sequence state for degraded history', async () => {
		const cache = new ChatTranscriptCache({ limit: 100 });
		cache.replaceFromPage('chat-1', page('generation-1', [entry(1, 'stale')]));
		const loadPage = vi.fn().mockResolvedValue({
			historyState: {
				kind: 'degraded',
				errorCode: 'CARRYOVER_HISTORY_UNAVAILABLE',
				retryable: false,
			},
			chatId: 'chat-1',
			messages: [],
		});
		const loader = new BackgroundTranscriptLoader({ cache, loadPage });

		loader.queueLoad('chat-1', {
			transcriptViewId: 'generation-1',
			messages: [entry(2, 'held')],
			firstOrdinal: 2,
			lastOrdinal: 2,
		});
		await loader.waitForIdle('chat-1');

		expect(cache.get('chat-1')).toBeNull();
	});
});
