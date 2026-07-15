import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTranscriptLoader } from '$lib/chat/transcript/background-transcript-loader.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { ChatViewMessage, ChatViewPage } from '$shared/chat-view';

const TS = '2024-01-01T00:00:00.000Z';

function entry(seq: number, content: string): ChatViewMessage {
	return {
		seq,
		message: new UserMessage(TS, content) as ChatMessage,
	};
}

function page(
	generationId: string,
	messages: ChatViewMessage[],
	lastSeq = messages.at(-1)?.seq ?? 0,
): ChatViewPage {
	return {
		generationId,
		messages,
		lastSeq,
		pageOldestSeq: messages[0]?.seq ?? 0,
		hasMore: false,
	};
}

function seqs(cache: ChatTranscriptCache, chatId = 'chat-1'): number[] {
	return cache.get(chatId)?.messages.map((item) => item.seq) ?? [];
}

describe('BackgroundTranscriptLoader', () => {
	beforeEach(() => {
		localStorage.clear();
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
			generationId: 'generation-1',
			messages: [entry(3, 'three')],
			lastSeq: 3,
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
			.mockImplementation((chatId, generationId, messages, lastSeq) => {
				const result = applyMessages(chatId, generationId, messages, lastSeq);
				if (!queuedLateBatch) {
					queuedLateBatch = true;
					loader.queueLoad('chat-1', {
						generationId: 'generation-1',
						messages: [entry(4, 'four')],
						lastSeq: 4,
					});
				}
				return result;
			});

		loader.queueLoad('chat-1', {
			generationId: 'generation-1',
			messages: [entry(3, 'three')],
			lastSeq: 3,
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
						generationId: 'generation-1',
						messages: [entry(3, 'three')],
						lastSeq: 3,
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
			generationId: 'generation-1',
			messages: [entry(2, 'two')],
			lastSeq: 2,
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
			generationId: 'generation-1',
			messages: [entry(2, 'old')],
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
});
