import { afterEach, expect, it, vi } from 'vitest';
import { getChatMessages } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';
import { AssistantMessage } from '$shared/chat-types';
import type { ChatHistoryResponse, CompleteChatHistoryResponse } from '$shared/chat-view';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));
const target = { chatId: '1000000000000001', transcriptViewId: 'view-one', ordinal: 100 };
const row = (ordinal: number) => ({
	ordinal,
	message: new AssistantMessage('2026-01-01T00:00:00.000Z', `Synthetic row ${ordinal}`),
});
function page(): CompleteChatHistoryResponse {
	return {
		chatId: target.chatId,
		transcriptViewId: target.transcriptViewId,
		historyState: { kind: 'complete' },
		messages: [row(100)],
		lastOrdinal: 1000,
		pageOldestOrdinal: 100,
		pageNewestOrdinal: 100,
		nextBeforeOrdinal: 51,
		hasMore: true,
		resendCandidates: [],
		limit: 50,
	};
}
function fixture() {
	const transcript = new ActiveTranscriptState();
	transcript.replaceGeneration(target.chatId, target.transcriptViewId, [row(1000)], {
		lastOrdinal: 1000,
		pageOldestOrdinal: 1000,
		nextBeforeOrdinal: 951,
		hasMore: true,
	});
	return transcript;
}
function held<T>() {
	let release!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
afterEach(() => vi.resetAllMocks());

it('loads one bounded raw target page even across a long hidden interval, preserving the live cache', async () => {
	const transcript = fixture();
	vi.mocked(getChatMessages).mockResolvedValue(page());
	const abort = new AbortController();
	expect(await transcript.navigateToRow(target, abort.signal, () => true)).toBe('loaded');
	expect(getChatMessages).toHaveBeenCalledExactlyOnceWith(
		{
			chatId: target.chatId,
			transcriptViewId: target.transcriptViewId,
			beforeOrdinal: 101,
			limit: 50,
		},
		{ signal: expect.any(AbortSignal) },
	);
	expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([100]);
	expect(transcript.loadedThroughOrdinal).toBe(100);
	expect(transcript.lastOrdinal).toBe(1000);
	expect(transcript.nextBeforeOrdinal).toBe(51);
	expect(transcript.hasLaterMessages).toBe(true);
	expect(
		transcript.transcriptCache.get(target.chatId)?.messages.map((entry) => entry.ordinal),
	).toEqual([1000]);
});

it.each(['caller', 'window', 'chat', 'snapshot'] as const)('aborts exact-row transport when superseded by %s', async (owner) => {
	const transcript = fixture();
	const caller = new AbortController();
	let requestSignal: AbortSignal | null | undefined;
	vi.mocked(getChatMessages).mockImplementation((_request, options) => new Promise((_resolve, reject) => {
		requestSignal = options?.signal;
		requestSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
	}));
	const work = transcript.navigateToRow(target, caller.signal, () => true);
	expect(requestSignal?.aborted).toBe(false);
	let snapshotEpoch: number | undefined;
	if (owner === 'caller') caller.abort();
	else if (owner === 'window') transcript.invalidatePendingWindowNavigation();
	else if (owner === 'chat') transcript.activateChat('1000000000000002');
	else snapshotEpoch = transcript.beginSnapshotLoad();
	expect(requestSignal?.aborted).toBe(true);
	await expect(work).resolves.toBe(owner === 'snapshot' ? 'unavailable' : 'cancelled');
	expect(transcript.entries.some((entry) => entry.ordinal === target.ordinal)).toBe(false);
	if (snapshotEpoch !== undefined) transcript.abortSnapshotLoad(snapshotEpoch);
});

it.each(['cancel', 'focus', 'window', 'chat'] as const)(
	'rejects a held page after %s supersedes it',
	async (change) => {
		const transcript = fixture();
		const read = held<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValue(read.promise);
		let current = true;
		const abort = new AbortController();
		const work = transcript.navigateToRow(target, abort.signal, () => current);
		if (change === 'cancel') abort.abort();
		if (change === 'focus') current = false;
		if (change === 'window') transcript.invalidatePendingWindowNavigation();
		if (change === 'chat') transcript.activateChat('1000000000000002');
		read.release(page());
		expect(await work).toBe('cancelled');
		expect(transcript.entries.some((entry) => entry.ordinal === 100)).toBe(false);
	},
);

it.each(['pending-snapshot', 'aborted-snapshot', 'navigation-cancelled'] as const)(
	'rejects a snapshot-superseded target page after %s',
	async (change) => {
		const transcript = fixture();
		const read = held<ChatHistoryResponse>();
		vi.mocked(getChatMessages).mockReturnValue(read.promise);
		const abort = new AbortController();
		const work = transcript.navigateToRow(target, abort.signal, () => true);
		const epoch = transcript.beginSnapshotLoad();
		if (change === 'aborted-snapshot') transcript.abortSnapshotLoad(epoch);
		if (change === 'navigation-cancelled') abort.abort();
		read.release(page());
		expect(await work).toBe(change === 'navigation-cancelled' ? 'cancelled' : 'unavailable');
		expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1000]);
		transcript.abortSnapshotLoad(epoch);
	},
);

it('does not relabel a replaced-view ordinal or page a replacement view', async () => {
	const transcript = fixture();
	vi.mocked(getChatMessages).mockRejectedValue(
		new ApiError(409, 'Reloaded', 'STALE_TRANSCRIPT_VIEW'),
	);
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe(
		'view-changed',
	);
	expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1000]);
	expect(getChatMessages).toHaveBeenCalledOnce();
	transcript.replaceGeneration(target.chatId, 'replacement', [row(100)], {
		lastOrdinal: 100,
		pageOldestOrdinal: 100,
		nextBeforeOrdinal: 51,
		hasMore: true,
	});
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe(
		'view-changed',
	);
	expect(getChatMessages).toHaveBeenCalledOnce();
});

it('missing rows leave the current window intact; API failures propagate', async () => {
	const transcript = fixture();
	vi.mocked(getChatMessages).mockResolvedValue({ ...page(), messages: [], pageOldestOrdinal: 0 });
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe(
		'unavailable',
	);
	expect(transcript.entries.map((entry) => entry.ordinal)).toEqual([1000]);
	vi.mocked(getChatMessages).mockRejectedValue(new TypeError('Synthetic network failure'));
	await expect(
		transcript.navigateToRow(target, new AbortController().signal, () => true),
	).rejects.toThrow('Synthetic network failure');
});

it('reports unavailable instead of silent cancellation for an uncoordinated snapshot', async () => {
	const transcript = fixture();
	const epoch = transcript.beginSnapshotLoad();
	expect(await transcript.navigateToRow(target, new AbortController().signal, () => true)).toBe(
		'unavailable',
	);
	expect(getChatMessages).not.toHaveBeenCalled();
	transcript.abortSnapshotLoad(epoch);
});
