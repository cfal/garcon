import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import {
	applyTranscriptAppend,
	type ResendCandidate,
	type TranscriptMessage,
} from '$shared/chat-view';
import { WsRequestError } from '$lib/ws/ws-request-error.js';
import {
	CachedTranscriptResumes,
	planCachedTranscriptResume,
	resumeCachedTranscript,
	type CachedTranscriptResumeTarget,
	type TranscriptReplayPage,
	type TranscriptReplayPageReader,
	type TranscriptReplayRequest,
} from '../cached-transcript-resume.js';
import {
	TranscriptReconnectReplayState,
	type TranscriptBufferedBatch,
	type TranscriptReplayApplyResult,
} from '../transcript-reconnect-replay.js';
import { transcriptReplayPage } from '../../../../test/transcript-replay.js';

const TIMESTAMP = '2026-10-30T00:00:00.000Z';
const CHAT_ID = 'chat-1';

function rows(first: number, last: number): TranscriptMessage[] {
	return Array.from({ length: last - first + 1 }, (_, index) => ({
		ordinal: first + index,
		message: new AssistantMessage(TIMESTAMP, `row-${first + index}`),
	}));
}

function liveBatch(
	first: number,
	last: number,
	transcriptViewId = 'view-1',
): TranscriptBufferedBatch {
	return {
		transcriptViewId,
		firstOrdinal: first,
		lastOrdinal: last,
		messages: rows(first, last),
		resendCandidates: [],
		noticeRevision: 0,
	};
}

// Mirrors the panel registry: one cached window per chat, contiguous appends, and a
// replay buffer that holds live commits while a catch-up page is in flight.
class ResumeTarget implements CachedTranscriptResumeTarget {
	view: string | null = 'view-1';
	lastOrdinal: number;
	entries: TranscriptMessage[];
	stale = false;
	readonly commits: TranscriptBufferedBatch[] = [];
	readonly resendReplacements: ResendCandidate[][] = [];
	readonly markValidated = vi.fn(() => {
		this.stale = false;
	});
	readonly markChatStale = vi.fn(() => {
		this.stale = true;
	});
	readonly transcriptCache = {
		readAppliedCursor: () =>
			this.view === null
				? null
				: { transcriptViewId: this.view, lastOrdinal: this.lastOrdinal, stale: this.stale },
		markValidated: this.markValidated,
	};
	#epoch = 0;
	#active: { token: number; replay: TranscriptReconnectReplayState; replayToken: number } | null =
		null;

	constructor(lastOrdinal: number) {
		this.lastOrdinal = lastOrdinal;
		this.entries = lastOrdinal === 0 ? [] : rows(Math.max(1, lastOrdinal - 4), lastOrdinal);
	}

	beginReconnectReplay(chatId: string, transcriptViewId: string): number {
		this.#active?.replay.abort(this.#active.replayToken);
		const replay = new TranscriptReconnectReplayState((_chatId, batch) => this.commit(batch));
		const token = ++this.#epoch;
		this.#active = { token, replay, replayToken: replay.begin(chatId, transcriptViewId) };
		return token;
	}

	applyReconnectReplayPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale' {
		if (this.#active?.token !== token) return 'stale';
		return this.#active.replay.applyPage(this.#active.replayToken, chatId, batch);
	}

	finishReconnectReplay(token: number, chatId: string): TranscriptReplayApplyResult | 'stale' {
		const active = this.#active;
		if (active?.token !== token) return 'stale';
		this.#active = null;
		return active.replay.finish(active.replayToken, chatId);
	}

	abortReconnectReplay(token: number): void {
		if (this.#active?.token !== token) return;
		this.#active.replay.abort(this.#active.replayToken);
		this.#active = null;
	}

	noticeRevisionFor(): number {
		return 0;
	}

	replaceResendCandidates(_chatId: string, candidates: readonly ResendCandidate[]): void {
		this.resendReplacements.push([...candidates]);
	}

	live(batch: TranscriptBufferedBatch): TranscriptReplayApplyResult {
		if (this.#active?.replay.buffer(CHAT_ID, batch)) return 'applied';
		return this.commit(batch);
	}

	commit(batch: TranscriptBufferedBatch): TranscriptReplayApplyResult {
		this.commits.push(batch);
		if (batch.transcriptViewId !== this.view) {
			this.stale = true;
			return 'view-changed';
		}
		const applied = applyTranscriptAppend(this.entries, batch, this.lastOrdinal);
		if (applied.status === 'gap-detected') {
			this.stale = true;
			return 'gap-detected';
		}
		this.entries = applied.messages;
		this.lastOrdinal = applied.lastOrdinal;
		return 'applied';
	}
}

function heldReader() {
	const requests: TranscriptReplayRequest[] = [];
	let respond!: (page: TranscriptReplayPage) => void;
	let fail!: (error: unknown) => void;
	const reader: TranscriptReplayPageReader = (request) => {
		requests.push(request);
		return new Promise((resolve, reject) => {
			respond = resolve;
			fail = reject;
		});
	};
	return {
		reader,
		requests,
		respond: (page: TranscriptReplayPage) => respond(page),
		fail: (error: unknown) => fail(error),
	};
}

function startResume(target: ResumeTarget, readPage: TranscriptReplayPageReader) {
	const plan = planCachedTranscriptResume(target.transcriptCache.readAppliedCursor());
	if (plan.kind !== 'resume') throw new Error(`Expected a resumable cache, got ${plan.reason}`);
	return resumeCachedTranscript({
		chatId: CHAT_ID,
		plan,
		purpose: 'activation',
		target,
		readPage,
	});
}

function ordinals(target: ResumeTarget): number[] {
	return target.entries.map((entry) => entry.ordinal);
}

describe('cached transcript resume plan', () => {
	it('resumes a fresh cache from its applied cursor, including an empty transcript', () => {
		expect(
			planCachedTranscriptResume({ transcriptViewId: 'view-1', lastOrdinal: 42, stale: false }),
		).toEqual({ kind: 'resume', transcriptViewId: 'view-1', afterOrdinal: 42 });
		expect(
			planCachedTranscriptResume({ transcriptViewId: 'view-1', lastOrdinal: 0, stale: false }),
		).toEqual({ kind: 'resume', transcriptViewId: 'view-1', afterOrdinal: 0 });
	});

	it('requires a snapshot for a missing, viewless, or stale cache', () => {
		expect(planCachedTranscriptResume(null)).toEqual({ kind: 'snapshot', reason: 'no-cache' });
		expect(
			planCachedTranscriptResume({ transcriptViewId: '', lastOrdinal: 3, stale: false }),
		).toEqual({ kind: 'snapshot', reason: 'no-cache' });
		expect(
			planCachedTranscriptResume({ transcriptViewId: 'view-1', lastOrdinal: 3, stale: true }),
		).toEqual({ kind: 'snapshot', reason: 'stale-cache' });
	});
});

describe('cached transcript resume', () => {
	it('[TLV5-REPLAY.08-WEB-UNIT-01] requests only rows after the cursor and applies them once', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);
		expect(server.requests).toEqual([
			{ chatId: CHAT_ID, transcriptViewId: 'view-1', afterOrdinal: 5, purpose: 'activation' },
		]);

		server.respond(
			transcriptReplayPage(server.requests[0]!, { messages: rows(6, 8), throughOrdinal: 8 }),
		);
		const result = await resume;

		expect(result).toMatchObject({
			kind: 'resumed',
			transcriptViewId: 'view-1',
			throughOrdinal: 8,
			deliveredMessages: 3,
			transientFeed: { chatId: CHAT_ID, transcriptViewId: 'view-1' },
		});
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(target.markValidated).toHaveBeenCalledOnce();
		expect(target.markChatStale).not.toHaveBeenCalled();
	});

	it('catches up an arbitrarily stale cache that received no live rows', async () => {
		const target = new ResumeTarget(3);
		const server = heldReader();
		const resume = startResume(target, server.reader);

		server.respond(
			transcriptReplayPage(server.requests[0]!, { messages: rows(4, 180), throughOrdinal: 180 }),
		);

		expect(await resume).toMatchObject({
			kind: 'resumed',
			throughOrdinal: 180,
			deliveredMessages: 177,
		});
		expect(ordinals(target)).toEqual(Array.from({ length: 180 }, (_, index) => index + 1));
	});

	it('holds live rows behind the page and applies overlapping rows exactly once', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);

		expect(target.live(liveBatch(7, 9))).toBe('applied');
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5]);
		server.respond(
			transcriptReplayPage(server.requests[0]!, { messages: rows(6, 8), throughOrdinal: 8 }),
		);

		expect(await resume).toMatchObject({ kind: 'resumed', throughOrdinal: 8 });
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(target.live(liveBatch(10, 10))).toBe('applied');
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it('requires a snapshot when a held live row leaves a gap after the page', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);

		target.live(liveBatch(11, 11));
		server.respond(
			transcriptReplayPage(server.requests[0]!, { messages: rows(6, 8), throughOrdinal: 8 }),
		);

		expect(await resume).toEqual({ kind: 'snapshot-required', reason: 'apply-failed' });
		expect(target.markChatStale).toHaveBeenCalledOnce();
		expect(target.markValidated).not.toHaveBeenCalled();
	});

	it('requires a snapshot without applying a delta larger than one page', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);
		target.live(liveBatch(1_000, 1_000));

		server.respond(
			transcriptReplayPage(server.requests[0]!, {
				messages: rows(6, 205),
				throughOrdinal: 999,
				hasMore: true,
			}),
		);

		expect(await resume).toEqual({ kind: 'snapshot-required', reason: 'delta-exceeds-page' });
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5]);
		expect(target.commits).toEqual([]);
		expect(target.markChatStale).toHaveBeenCalledOnce();
		expect(target.live(liveBatch(1_001, 1_001))).toBe('gap-detected');
	});

	it.each([
		[
			new WsRequestError('STALE_TRANSCRIPT_VIEW', 'Transcript view changed', false),
			'view-replaced',
		],
		[
			new WsRequestError('REQUEST_VALIDATION_FAILED', 'Cursor ahead of view', false),
			'cursor-rejected',
		],
		[new WsRequestError('HISTORY_LOAD_FAILED', 'Ledger unavailable', true), 'replay-failed'],
		[new Error('WebSocket not connected'), 'replay-failed'],
	])('requires a snapshot when the server cannot prove the cursor (%s)', async (error, reason) => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);

		server.fail(error);

		expect(await resume).toEqual({ kind: 'snapshot-required', reason });
		expect(target.markChatStale).toHaveBeenCalledOnce();
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5]);
	});

	it('validates an unchanged head without committing a no-op batch', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);
		const candidates = [{ ordinal: 5, content: 'resend', attachmentNames: [] }];

		server.respond({ ...transcriptReplayPage(server.requests[0]!), resendCandidates: candidates });

		expect(await resume).toMatchObject({
			kind: 'resumed',
			throughOrdinal: 5,
			deliveredMessages: 0,
		});
		expect(target.commits).toEqual([]);
		expect(target.resendReplacements).toEqual([candidates]);
		expect(target.markValidated).toHaveBeenCalledOnce();
	});

	it('yields to a newer replay without applying or invalidating the cache', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);
		target.beginReconnectReplay(CHAT_ID, 'view-1');

		server.respond(
			transcriptReplayPage(server.requests[0]!, { messages: rows(6, 6), throughOrdinal: 6 }),
		);

		expect(await resume).toEqual({ kind: 'superseded' });
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5]);
		expect(target.markChatStale).not.toHaveBeenCalled();
	});

	it.each(['respond', 'fail'] as const)(
		'yields to a view the cache adopted while the page was in flight (%s)',
		async (outcome) => {
			const target = new ResumeTarget(5);
			const server = heldReader();
			const resume = startResume(target, server.reader);
			target.view = 'view-2';
			target.lastOrdinal = 1;

			if (outcome === 'respond') {
				server.respond(
					transcriptReplayPage(server.requests[0]!, { messages: rows(6, 6), throughOrdinal: 6 }),
				);
			} else {
				server.fail(new WsRequestError('STALE_TRANSCRIPT_VIEW', 'Transcript view changed', false));
			}

			expect(await resume).toEqual({ kind: 'superseded' });
			expect(target.commits).toEqual([]);
			expect(target.markChatStale).not.toHaveBeenCalled();
			expect(target.markValidated).not.toHaveBeenCalled();
		},
	);
});

function queuedReader() {
	const pending: Array<{
		request: TranscriptReplayRequest;
		respond: (page: TranscriptReplayPage) => void;
	}> = [];
	const reader: TranscriptReplayPageReader = (request) =>
		new Promise((resolve) => pending.push({ request, respond: resolve }));
	return { reader, pending };
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe('cached transcript gap follow-up', () => {
	it('[TLV5-REPLAY.09-WEB-UNIT-02] queues one follow-up from the advanced cursor after a pending catch-up', async () => {
		const target = new ResumeTarget(5);
		const server = queuedReader();
		const resumes = new CachedTranscriptResumes(target, server.reader);
		const pending = resumes.resume(CHAT_ID, { purpose: 'activation' });

		const followUp = resumes.resumeAfterGap(CHAT_ID);
		expect(resumes.resumeAfterGap(CHAT_ID)).toBe(followUp);
		await settle();
		expect(server.pending.map((entry) => entry.request.afterOrdinal)).toEqual([5]);

		server.pending[0]!.respond(
			transcriptReplayPage(server.pending[0]!.request, { messages: rows(6, 8), throughOrdinal: 8 }),
		);
		await expect(pending).resolves.toMatchObject({ kind: 'resumed', throughOrdinal: 8 });
		await settle();
		expect(server.pending.map((entry) => entry.request)).toEqual([
			{ chatId: CHAT_ID, transcriptViewId: 'view-1', afterOrdinal: 5, purpose: 'activation' },
			{ chatId: CHAT_ID, transcriptViewId: 'view-1', afterOrdinal: 8 },
		]);

		server.pending[1]!.respond(
			transcriptReplayPage(server.pending[1]!.request, {
				messages: rows(9, 11),
				throughOrdinal: 11,
			}),
		);
		await expect(followUp).resolves.toMatchObject({ kind: 'resumed', throughOrdinal: 11 });
		expect(ordinals(target)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
		expect(target.markChatStale).not.toHaveBeenCalled();
	});

	it('cancels a forgotten replay and its queued follow-up even if the same view is reseeded', async () => {
		const target = new ResumeTarget(5);
		const server = queuedReader();
		const resumes = new CachedTranscriptResumes(target, server.reader);
		const pending = resumes.resume(CHAT_ID);
		const followUp = resumes.resumeAfterGap(CHAT_ID);
		resumes.forget(CHAT_ID);
		server.pending[0]!.respond(
			transcriptReplayPage(server.pending[0]!.request, { messages: rows(6, 8), throughOrdinal: 8 }),
		);
		await expect(pending).resolves.toEqual({ kind: 'superseded' });
		await expect(followUp).resolves.toEqual({ kind: 'superseded' });
		expect(server.pending).toHaveLength(1);
		expect(target.commits).toEqual([]);
		expect(target.markValidated).not.toHaveBeenCalled();
	});

	it('starts a follow-up from the retained prefix when nothing is pending', async () => {
		const target = new ResumeTarget(5);
		const server = queuedReader();
		const resumes = new CachedTranscriptResumes(target, server.reader);

		const followUp = resumes.resumeAfterGap(CHAT_ID);
		await settle();

		expect(server.pending.map((entry) => entry.request)).toEqual([
			{ chatId: CHAT_ID, transcriptViewId: 'view-1', afterOrdinal: 5 },
		]);
		server.pending[0]!.respond(
			transcriptReplayPage(server.pending[0]!.request, { messages: rows(6, 7), throughOrdinal: 7 }),
		);
		await expect(followUp).resolves.toMatchObject({ kind: 'resumed', throughOrdinal: 7 });
	});

	it('requires a snapshot when the cache was invalidated before the follow-up starts', async () => {
		const target = new ResumeTarget(5);
		const server = queuedReader();
		const resumes = new CachedTranscriptResumes(target, server.reader);
		target.stale = true;

		await expect(resumes.resumeAfterGap(CHAT_ID)).resolves.toEqual({
			kind: 'snapshot-required',
			reason: 'stale-cache',
		});
		expect(server.pending).toEqual([]);
	});
});
