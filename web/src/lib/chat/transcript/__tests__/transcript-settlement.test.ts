import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantMessage, UserMessage } from '$shared/chat-types';
import type { TranscriptMessage, TranscriptPage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { ActiveTranscriptState } from '../active-transcript-state.svelte.js';
import { ChatTranscriptCache } from '../chat-transcript-cache.svelte.js';
import { ConversationTranscriptOverlayStore } from '../conversation-transcript-overlay-store.svelte.js';
import { transcriptPresentationKey } from '../transcript-presentation-key.js';
import { TRANSCRIPT_BUFFER_ROW_LIMIT } from '../transcript-batch-buffer.js';

vi.mock('$lib/api/chats.js', () => ({ getChatMessages: vi.fn() }));

const timestamp = '2026-01-01T00:00:00.000Z';
const assistant = (ordinal: number): TranscriptMessage => ({ ordinal, message: new AssistantMessage(timestamp, `Synthetic ${ordinal}`) });
const echo = (ordinal: number, clientMessageId = 'input-1'): TranscriptMessage => ({
	ordinal, message: new UserMessage(timestamp, 'Synthetic input', undefined, { clientMessageId }),
});
const page = (messages: TranscriptMessage[], lastOrdinal: number, transcriptViewId = 'view-1'): TranscriptPage => ({
	transcriptViewId, messages, lastOrdinal, pageNewestOrdinal: lastOrdinal,
	pageOldestOrdinal: messages[0]?.ordinal ?? 0, nextBeforeOrdinal: null, hasMore: false,
});

function fixture() {
	const cache = new ChatTranscriptCache({ limit: 100, persistenceDelayMs: 0 });
	cache.replaceFromPage('chat-1', page([assistant(1)], 1));
	const overlays = new ConversationTranscriptOverlayStore();
	const transcript = new ActiveTranscriptState(cache, overlays.forChat('chat-1'));
	transcript.activateChat('chat-1');
	const submit = (clientMessageId = 'input-1') => transcript.applySharedOverlayMutation(overlays.upsertOptimisticInput('chat-1', {
		chatId: 'chat-1', clientMessageId, content: 'Synthetic input', createdAt: timestamp, delivery: 'pending',
	}, 1));
	const commit = (messages: TranscriptMessage[], firstOrdinal: number, lastOrdinal: number) => {
		const batch = { chatId: 'chat-1', transcriptViewId: 'view-1', messages, firstOrdinal, lastOrdinal, resendCandidates: [], noticeRevision: 0 };
		const outcome = cache.applyMessages('chat-1', 'view-1', batch);
		if (outcome.status !== 'applied') throw new Error(outcome.status);
		const result = transcript.applySharedCommit({ ...batch, outcome });
		transcript.applySharedOverlayMutation(overlays.applyCommittedBatch(batch));
		return result;
	};
	return { cache, transcript, overlays, submit, commit };
}

describe('panel-local optimistic settlement', () => {
	beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });

	it('marks a held echo delivered even before HTTP acknowledgement', () => {
		const { cache, transcript, submit, commit } = fixture();
		submit();
		const epoch = transcript.beginSnapshotLoad();
		commit([echo(2)], 2, 2);
		expect(transcript.visibleOptimisticInputs).toMatchObject([{ clientMessageId: 'input-1', delivery: 'delivered' }]);
		expect(transcript.displayRows.at(-1)).not.toHaveProperty('awaitingDelivery', true);
		transcript.abortSnapshotLoad(epoch);
		cache.flush();
	});

	it('releases a retained handoff when later paging publishes its canonical row', async () => {
		const { cache, transcript, submit, commit } = fixture();
		submit();
		const epoch = transcript.beginSnapshotLoad();
		const through = TRANSCRIPT_BUFFER_ROW_LIMIT + 3;
		commit([], 2, through - 1);
		commit([echo(through)], through, through);
		transcript.abortSnapshotLoad(epoch);
		expect(transcript.visibleOptimisticInputs).toHaveLength(1);
		vi.mocked(getChatMessages).mockImplementation(async (request) => {
			const limit = request.limit ?? 50;
			const newest = request.beforeOrdinal! - 1;
			const oldest = Math.max(1, newest - limit + 1);
			return {
				chatId: 'chat-1', limit, historyState: { kind: 'complete' }, resendCandidates: [],
				...page(newest === through ? [echo(through)] : [], through), pageNewestOrdinal: newest,
				nextBeforeOrdinal: oldest > 1 ? oldest : null, hasMore: oldest > 1,
			};
		});
		await expect(transcript.loadLaterPage('chat-1', { visibleLimit: 200 })).resolves.toBe('loaded');
		expect(transcript.entries.map((row) => row.ordinal)).toEqual([1, through]);
		expect(transcript.visibleOptimisticInputs).toEqual([]);
		// Removing echo evidence distinguishes released handoffs from projection-only suppression.
		transcript.entries = [assistant(1)];
		expect(transcript.visibleOptimisticInputs).toEqual([]);
		cache.flush();
	});

	it('discards a mixed-view buffer rejected during peer snapshot installation', () => {
		const { cache, transcript, commit } = fixture();
		transcript.beginSnapshotLoad();
		commit([assistant(2)], 2, 2);
		const replacement = {
			chatId: 'chat-1', transcriptViewId: 'view-2', messages: [assistant(1)],
			firstOrdinal: 1, lastOrdinal: 1, resendCandidates: [], noticeRevision: 0,
			outcome: { status: 'applied', changed: true, lastOrdinal: 1 } as const,
		};
		transcript.applySharedCommit(replacement);
		cache.replaceFromPage('chat-1', page([assistant(1)], 1, 'view-2'));
		expect(transcript.installCachedSnapshot('chat-1')).toBe('view-changed');
		expect(transcript.isLoadingMessages).toBe(false);
		expect(transcript.applySharedCommit(replacement)).toBe('view-changed');
		expect(transcript.installCachedSnapshot('chat-1')).toBe('applied');
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-2:1']);
		cache.flush();
	});

	it('drains a rejected overrun cached snapshot instead of keeping silent buffering', () => {
		const { cache, transcript, commit } = fixture();
		transcript.beginSnapshotLoad();
		commit([assistant(2)], 2, 2);
		commit([], 3, TRANSCRIPT_BUFFER_ROW_LIMIT + 3);
		cache.replaceFromPage('chat-1', page([assistant(1)], 1));
		expect(transcript.installCachedSnapshot('chat-1')).toBe('gap-detected');
		expect(transcript.isLoadingMessages).toBe(false);
		expect(transcript.loadedThroughOrdinal).toBe(2);
		expect(commit([assistant(3)], 3, 3)).toBe('applied');
		expect(transcript.entries.map((row) => row.ordinal)).toEqual([1, 2, 3]);
		cache.flush();
	});

	it('releases a snapshot echo intentionally outside a preserved historical window', () => {
		const { cache, transcript, submit } = fixture();
		submit();
		const epoch = transcript.beginSnapshotLoad();
		expect(transcript.setFromPage('chat-1', {
			...page([echo(101)], 101), nextBeforeOrdinal: 101, hasMore: true,
		}, epoch)).toBe('applied');
		expect(transcript.entries.map((row) => row.ordinal)).toEqual([1]);
		expect(transcript.hasLaterMessages).toBe(true);
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1']);
		cache.flush();
	});

	it.each(['failure', 'cancel'] as const)('retains an overrun echo across snapshot %s without advancing loaded coverage', async (outcome) => {
		const { cache, transcript, submit, commit } = fixture();
		submit();
		let reject!: (error: Error) => void;
		vi.mocked(getChatMessages).mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
		const loading = outcome === 'failure' ? transcript.loadMessages('chat-1') : null;
		const epoch = loading ? null : transcript.beginSnapshotLoad();
		expect(commit([], 2, TRANSCRIPT_BUFFER_ROW_LIMIT + 2)).toBe('gap-detected');
		expect(commit([echo(TRANSCRIPT_BUFFER_ROW_LIMIT + 3)], TRANSCRIPT_BUFFER_ROW_LIMIT + 3, TRANSCRIPT_BUFFER_ROW_LIMIT + 3)).toBe('gap-detected');
		if (loading) {
			reject(new Error('Synthetic failure'));
			await expect(loading).rejects.toThrow('Synthetic failure');
		} else transcript.abortSnapshotLoad(epoch!);
		expect(transcript.loadedThroughOrdinal).toBe(1);
		expect(transcript.hasLaterMessages).toBe(true);
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'optimistic:input-1']);
		cache.flush();
	});

	it.each(['snapshot', 'buffer'] as const)('[TLV5-UX.05-WEB-SETTLEMENT-01] preserves a cold-panel submission until its echo is in the %s', (source) => {
		const { cache, transcript, submit, commit } = fixture();
		transcript.clearMessages();
		submit();
		const key = transcriptPresentationKey(transcript.displayRows[0]);
		const epoch = transcript.beginSnapshotLoad();
		expect(commit([echo(2)], 2, 2)).toBe('applied');
		expect(transcript.entries).toEqual([]);
		expect(transcript.displayRows.map(transcriptPresentationKey)).toEqual([key]);
		expect(transcript.setFromPage('chat-1', source === 'snapshot' ? page([assistant(1), echo(2)], 2) : page([assistant(1)], 1), epoch)).toBe('applied');
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'view-1:2']);
		expect(transcriptPresentationKey(transcript.displayRows[1])).toBe(key);
		cache.flush();
	});

	it('keeps both identities when echoes arrive in reverse submission order', () => {
		const { cache, transcript, submit, commit } = fixture();
		submit('input-1');
		submit('input-2');
		const keys = transcript.displayRows.slice(1).map(transcriptPresentationKey);
		const epoch = transcript.beginSnapshotLoad();
		commit([echo(2, 'input-2')], 2, 2);
		commit([echo(3, 'input-1')], 3, 3);
		expect(transcript.displayRows.slice(1).map(transcriptPresentationKey)).toEqual(keys);
		expect(transcript.displayRows).toHaveLength(3);
		transcript.setFromPage('chat-1', page([assistant(1)], 1), epoch);
		expect(transcript.displayRows.slice(1).map(transcriptPresentationKey)).toEqual([...keys].reverse());
		cache.flush();
	});

	it('publishes the buffered echo when a refresh fails', async () => {
		const { cache, transcript, submit, commit } = fixture();
		submit();
		let reject!: (error: Error) => void;
		vi.mocked(getChatMessages).mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
		const loading = transcript.loadMessages('chat-1');
		commit([echo(2)], 2, 2);
		expect(transcript.displayRows).toHaveLength(2);
		reject(new Error('Synthetic refresh failure'));
		await expect(loading).rejects.toThrow('Synthetic refresh failure');
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'view-1:2']);
		cache.flush();
	});

	it('discards a pending handoff when its view is explicitly replaced', () => {
		const { cache, transcript, submit, commit } = fixture();
		submit();
		transcript.beginSnapshotLoad();
		commit([echo(2)], 2, 2);
		transcript.replaceGeneration('chat-1', 'view-2', [assistant(1)], page([assistant(1)], 1, 'view-2'));
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-2:1']);
		cache.flush();
	});

	it('rejects an overrun snapshot, retains its handoff, and recovers from a fresh watermark', () => {
		const { cache, transcript, submit, commit } = fixture();
		submit();
		const epoch = transcript.beginSnapshotLoad();
		commit([echo(2)], 2, 2);
		expect(commit([], 3, TRANSCRIPT_BUFFER_ROW_LIMIT + 3)).toBe('gap-detected');
		expect(transcript.setFromPage('chat-1', page([assistant(1)], 1), epoch)).toBe('gap-detected');
		expect(transcript.entries.map((row) => row.ordinal)).toEqual([1]);
		expect(transcript.displayRows).toHaveLength(2);
		const recoveryEpoch = transcript.beginSnapshotLoad();
		expect(transcript.setFromPage('chat-1', page([assistant(1), echo(2)], TRANSCRIPT_BUFFER_ROW_LIMIT + 3), recoveryEpoch)).toBe('applied');
		expect(transcript.displayRows.map((row) => row.id)).toEqual(['view-1:1', 'view-1:2']);
		cache.flush();
	});
});
