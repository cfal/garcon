import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '$shared/chat-types';
import {
	applyTranscriptAppend,
	type ResendCandidate,
	type TranscriptMessage,
} from '$shared/chat-view';
import { WsRequestError } from '$lib/ws/ws-request-error.js';
import {
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

function liveBatch(first: number, last: number, transcriptViewId = 'view-1'): TranscriptBufferedBatch {
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

		server.respond(transcriptReplayPage(server.requests[0]!, { messages: rows(6, 8), throughOrdinal: 8 }));
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

		expect(await resume).toMatchObject({ kind: 'resumed', throughOrdinal: 180, deliveredMessages: 177 });
		expect(ordinals(target)).toEqual(Array.from({ length: 180 }, (_, index) => index + 1));
	});

	it('holds live rows behind the page and applies overlapping rows exactly once', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);

		expect(target.live(liveBatch(7, 9))).toBe('applied');
		expect(ordinals(target)).toEqual([1, 2, 3, 4, 5]);
		server.respond(transcriptReplayPage(server.requests[0]!, { messages: rows(6, 8), throughOrdinal: 8 }));

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
		server.respond(transcriptReplayPage(server.requests[0]!, { messages: rows(6, 8), throughOrdinal: 8 }));

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
		[new WsRequestError('STALE_TRANSCRIPT_VIEW', 'Transcript view changed', false), 'view-replaced'],
		[new WsRequestError('REQUEST_VALIDATION_FAILED', 'Cursor ahead of view', false), 'cursor-rejected'],
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

		expect(await resume).toMatchObject({ kind: 'resumed', throughOrdinal: 5, deliveredMessages: 0 });
		expect(target.commits).toEqual([]);
		expect(target.resendReplacements).toEqual([candidates]);
		expect(target.markValidated).toHaveBeenCalledOnce();
	});

	it('yields to a newer replay without applying or invalidating the cache', async () => {
		const target = new ResumeTarget(5);
		const server = heldReader();
		const resume = startResume(target, server.reader);
		target.beginReconnectReplay(CHAT_ID, 'view-1');

		server.respond(transcriptReplayPage(server.requests[0]!, { messages: rows(6, 6), throughOrdinal: 6 }));

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
				server.respond(transcriptReplayPage(server.requests[0]!, { messages: rows(6, 6), throughOrdinal: 6 }));
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
