import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import type { CompleteChatHistoryResponse } from '$shared/chat-view';
import type { ChatMessagesRequest } from '$lib/api/chats.js';
import { collapseBackwardTranscriptDemand, loadTranscriptPageDemand } from '../transcript-page-demand.js';
import { TranscriptReadBudget, TRANSCRIPT_READ_REQUEST_LIMIT } from '../transcript-read-budget.js';

function hiddenPage(request: ChatMessagesRequest, lastOrdinal = 10_000): CompleteChatHistoryResponse {
	const limit = request.limit ?? 50;
	const pageNewestOrdinal = Math.min(request.beforeOrdinal ?? lastOrdinal + 1, lastOrdinal + 1) - 1;
	const first = Math.max(1, pageNewestOrdinal - limit + 1);
	return {
		chatId: request.chatId,
		transcriptViewId: 'view-1',
		limit,
		messages: [],
		resendCandidates: [],
		historyState: { kind: 'complete' },
		lastOrdinal,
		pageOldestOrdinal: 0,
		pageNewestOrdinal,
		nextBeforeOrdinal: first > 1 ? first : null,
		hasMore: first > 1,
	};
}

describe('bounded transcript page demand', () => {
	it('[TLV5-PAGE.09-WEB-DEMAND-01] stops a hidden-only tail at the request budget and resumes without losing raw coverage', async () => {
		const loadPage = vi.fn(async (request: ChatMessagesRequest) => hiddenPage(request));
		const options = { direction: 'backward', chatId: 'chat-1', visibleLimit: 200, loadPage } as const;
		const first = await loadTranscriptPageDemand(options);
		expect(first.kind).toBe('complete');
		if (first.kind !== 'complete') throw new Error('Expected complete demand');
		expect(first.stop).toBe('budget');
		expect(loadPage).toHaveBeenCalledTimes(TRANSCRIPT_READ_REQUEST_LIMIT);
		expect(first.messages).toEqual([]);
		const page = collapseBackwardTranscriptDemand(first);
		expect(page).toMatchObject({ pageNewestOrdinal: 10_000, nextBeforeOrdinal: 8_001, hasMore: true });
		const next = await loadTranscriptPageDemand({
			...options, transcriptViewId: page.transcriptViewId, beforeOrdinal: page.nextBeforeOrdinal!,
		});
		expect(next.kind).toBe('complete');
		if (next.kind !== 'complete') throw new Error('Expected complete demand');
		expect(collapseBackwardTranscriptDemand(next)).toMatchObject({
			pageNewestOrdinal: 8_000, nextBeforeOrdinal: 6_001, hasMore: true,
		});
	});

	it('retains presentable rows when the remaining hidden scan reaches its budget', async () => {
		const loadPage = vi.fn(async (request: ChatMessagesRequest) => {
			const page = hiddenPage(request);
			if (request.beforeOrdinal !== undefined) return page;
			return {
				...page,
				pageOldestOrdinal: 10_000,
				messages: [{ ordinal: 10_000, message: new AssistantMessage('2026-01-01T00:00:00Z', 'Synthetic reply') }],
			};
		});
		const result = await loadTranscriptPageDemand({
			direction: 'backward', chatId: 'chat-1', visibleLimit: 50, loadPage,
		});
		expect(result).toMatchObject({ kind: 'complete', stop: 'budget', messages: [{ ordinal: 10_000 }] });
		expect(loadPage).toHaveBeenCalledTimes(10);
	});

	it('bounds forward hidden scans and never chases a growing head beyond its watermark', async () => {
		const loadPage = vi.fn(async (request: ChatMessagesRequest) => hiddenPage(request, 12_000));
		const options = {
			direction: 'later', chatId: 'chat-1', transcriptViewId: 'view-1',
			visibleLimit: 200, throughOrdinal: 2_010, loadPage,
		} as const;
		const first = await loadTranscriptPageDemand({ ...options, afterOrdinal: 0 });
		expect(first.kind).toBe('complete');
		if (first.kind !== 'complete') throw new Error('Expected complete demand');
		expect(first.stop).toBe('budget');
		expect(first.pages.at(-1)?.pageNewestOrdinal).toBe(2_000);
		const last = await loadTranscriptPageDemand({ ...options, afterOrdinal: 2_000 });
		expect(last.kind).toBe('complete');
		if (last.kind !== 'complete') throw new Error('Expected complete demand');
		expect(last.stop).toBe('history-end');
		expect(last.pages.at(-1)?.pageNewestOrdinal).toBe(2_010);
		expect(loadPage).toHaveBeenCalledTimes(11);
	});

	it('distinguishes exhaustion from bounded progress even when all rows are hidden', async () => {
		const result = await loadTranscriptPageDemand({
			direction: 'backward', chatId: 'chat-1', visibleLimit: 50,
			loadPage: async (request) => hiddenPage(request, 60),
		});
		expect(result).toMatchObject({ kind: 'complete', stop: 'history-end', messages: [] });
		if (result.kind !== 'complete') throw new Error('Expected complete demand');
		expect(result.pages).toHaveLength(2);
		expect(collapseBackwardTranscriptDemand(result).hasMore).toBe(false);
	});

	it('shares the request allowance across logical demands, including failed requests', async () => {
		const budget = new TranscriptReadBudget();
		const loadPage = vi.fn(async (): Promise<CompleteChatHistoryResponse> => { throw new Error('Read failed'); });
		const options = { direction: 'backward', chatId: 'chat-1', visibleLimit: 50, budget, loadPage } as const;
		for (let i = 0; i < 10; i += 1) {
			await expect(loadTranscriptPageDemand(options)).rejects.toThrow('Read failed');
		}
		await expect(loadTranscriptPageDemand(options)).resolves.toMatchObject({
			kind: 'complete', stop: 'budget', pages: [],
		});
		expect(loadPage).toHaveBeenCalledTimes(10);
	});

	it('does not dispatch when already aborted or invalidated', async () => {
		const controller = new AbortController();
		controller.abort();
		const loadPage = vi.fn(async (request: ChatMessagesRequest) => hiddenPage(request));
		const options = { direction: 'backward', chatId: 'chat-1', visibleLimit: 50, loadPage } as const;
		await expect(loadTranscriptPageDemand({ ...options, signal: controller.signal })).resolves.toEqual({ kind: 'invalidated' });
		await expect(loadTranscriptPageDemand({ ...options, isCurrent: () => false })).resolves.toEqual({ kind: 'invalidated' });
		expect(loadPage).not.toHaveBeenCalled();
	});

	it('passes cancellation to transport and treats the rejection as invalidation', async () => {
		const controller = new AbortController();
		const loadPage = vi.fn(async (_request: ChatMessagesRequest, options?: { signal?: AbortSignal | null }): Promise<CompleteChatHistoryResponse> => {
			expect(options?.signal).toBe(controller.signal);
			controller.abort();
			throw new DOMException('Aborted', 'AbortError');
		});
		await expect(loadTranscriptPageDemand({
			direction: 'backward', chatId: 'chat-1', visibleLimit: 50, signal: controller.signal, loadPage,
		})).resolves.toEqual({ kind: 'invalidated' });
		expect(loadPage).toHaveBeenCalledOnce();
	});

	it('checks ownership before dispatching a continuation', async () => {
		let current = true;
		const loadPage = vi.fn(async (request: ChatMessagesRequest) => hiddenPage(request));
		await expect(loadTranscriptPageDemand({
			direction: 'backward', chatId: 'chat-1', visibleLimit: 50, loadPage,
			isCurrent: () => current,
			onPageValidated: () => { current = false; },
		})).resolves.toEqual({ kind: 'invalidated' });
		expect(loadPage).toHaveBeenCalledOnce();
	});
});
