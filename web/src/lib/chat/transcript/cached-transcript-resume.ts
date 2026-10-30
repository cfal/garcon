// Resumes a cached transcript window from its applied ledger cursor with one bounded
// replay page instead of refetching recent history. The cache is never trusted on its
// own: the server's view check and fixed watermark prove that the delta continues the
// cached frontier, and anything they cannot prove falls back to a newest-history snapshot.
// Live broadcasts are not assumed to have kept the cache current, so the delta is always
// derived from the server's sequence, however far behind the cache is.

import type { ChatTransientFeedSnapshot } from '$shared/chat-transient-feed';
import type { ResendCandidate, TranscriptReadPurpose } from '$shared/chat-view';
import type { ChatSubscribedMessage } from '$shared/ws-events';
import { WsRequestError } from '$lib/ws/ws-request-error.js';
import type {
	ChatTranscriptAppliedCursor,
	ChatTranscriptCache,
} from './chat-transcript-cache.svelte.js';
import type {
	TranscriptBufferedBatch,
	TranscriptReplayApplyResult,
} from './transcript-reconnect-replay.js';

export interface TranscriptReplayRequest {
	readonly chatId: string;
	readonly transcriptViewId: string;
	readonly afterOrdinal: number;
	readonly throughOrdinal?: number;
	readonly purpose?: TranscriptReadPurpose;
}

export type TranscriptReplayPage = Pick<
	ChatSubscribedMessage,
	| 'chatId'
	| 'transcriptViewId'
	| 'messages'
	| 'firstOrdinal'
	| 'lastOrdinal'
	| 'nextAfterOrdinal'
	| 'throughOrdinal'
	| 'hasMore'
	| 'resendCandidates'
	| 'transientFeed'
>;

// Resolves only with a page that continues the requested cursor.
export type TranscriptReplayPageReader = (
	request: TranscriptReplayRequest,
) => Promise<TranscriptReplayPage>;

export type CachedTranscriptSnapshotReason =
	| 'no-cache'
	| 'stale-cache'
	| 'view-replaced'
	| 'cursor-rejected'
	| 'delta-exceeds-page'
	| 'apply-failed'
	| 'replay-failed';

export type CachedTranscriptResumePlan =
	| { readonly kind: 'resume'; readonly transcriptViewId: string; readonly afterOrdinal: number }
	| { readonly kind: 'snapshot'; readonly reason: Extract<CachedTranscriptSnapshotReason, 'no-cache' | 'stale-cache'> };

export type CachedTranscriptResumeResult =
	| {
			readonly kind: 'resumed';
			readonly transcriptViewId: string;
			readonly throughOrdinal: number;
			readonly deliveredMessages: number;
			readonly transientFeed: ChatTransientFeedSnapshot;
	  }
	| { readonly kind: 'snapshot-required'; readonly reason: CachedTranscriptSnapshotReason }
	// A newer replay, a reconnect, or a disconnect took over the chat's replay buffer.
	| { readonly kind: 'superseded' };

export interface CachedTranscriptResumeTarget {
	readonly transcriptCache: Pick<ChatTranscriptCache, 'readAppliedCursor' | 'markValidated'>;
	beginReconnectReplay(chatId: string, transcriptViewId: string): number;
	applyReconnectReplayPage(
		token: number,
		chatId: string,
		batch: TranscriptBufferedBatch,
	): TranscriptReplayApplyResult | 'stale';
	finishReconnectReplay(token: number, chatId: string): TranscriptReplayApplyResult | 'stale';
	abortReconnectReplay(token: number, chatId: string): void;
	noticeRevisionFor(chatId: string): number;
	replaceResendCandidates(chatId: string, candidates: readonly ResendCandidate[]): void;
	markChatStale(chatId: string): void;
}

// A stale entry already failed a contiguity check, so only the server's newest page can
// rebuild it. A fresh entry may still be arbitrarily far behind; the replay decides that.
export function planCachedTranscriptResume(
	cursor: ChatTranscriptAppliedCursor | null,
): CachedTranscriptResumePlan {
	if (!cursor?.transcriptViewId) return { kind: 'snapshot', reason: 'no-cache' };
	if (cursor.stale) return { kind: 'snapshot', reason: 'stale-cache' };
	return {
		kind: 'resume',
		transcriptViewId: cursor.transcriptViewId,
		afterOrdinal: cursor.lastOrdinal,
	};
}

export async function resumeCachedTranscript(input: {
	readonly chatId: string;
	readonly plan: Extract<CachedTranscriptResumePlan, { kind: 'resume' }>;
	readonly purpose?: TranscriptReadPurpose;
	readonly target: CachedTranscriptResumeTarget;
	readonly readPage: TranscriptReplayPageReader;
}): Promise<CachedTranscriptResumeResult> {
	const { chatId, plan, target } = input;
	// Buffers live rows committed while the page is in flight and applies them after it.
	const token = target.beginReconnectReplay(chatId, plan.transcriptViewId);
	const snapshotRequired = (reason: CachedTranscriptSnapshotReason): CachedTranscriptResumeResult => {
		target.abortReconnectReplay(token, chatId);
		target.markChatStale(chatId);
		return { kind: 'snapshot-required', reason };
	};
	// A snapshot, replacement, or removal that changed the cache's view while the page was in
	// flight owns the window; applying or failing the older view would only mark it stale.
	const ownsCachedView = () =>
		target.transcriptCache.readAppliedCursor(chatId)?.transcriptViewId === plan.transcriptViewId;
	try {
		let page: TranscriptReplayPage;
		try {
			page = await input.readPage({
				chatId,
				transcriptViewId: plan.transcriptViewId,
				afterOrdinal: plan.afterOrdinal,
				...(input.purpose === undefined ? {} : { purpose: input.purpose }),
			});
		} catch (error) {
			if (!ownsCachedView()) return { kind: 'superseded' };
			return snapshotRequired(replayFailureReason(error));
		}
		if (!ownsCachedView()) return { kind: 'superseded' };
		// A delta beyond one bounded page costs more than the newest snapshot it would converge to.
		if (page.hasMore) return snapshotRequired('delta-exceeds-page');

		// An unchanged head commits nothing, so it must not enter panels' snapshot buffers.
		if (page.lastOrdinal === plan.afterOrdinal) {
			target.replaceResendCandidates(chatId, page.resendCandidates);
		} else {
			const applied = target.applyReconnectReplayPage(token, chatId, {
				transcriptViewId: page.transcriptViewId,
				messages: page.messages,
				firstOrdinal: page.firstOrdinal,
				lastOrdinal: page.lastOrdinal,
				resendCandidates: page.resendCandidates,
				noticeRevision: target.noticeRevisionFor(chatId),
			});
			if (applied === 'stale') return { kind: 'superseded' };
			if (applied !== 'applied') return snapshotRequired('apply-failed');
		}
		const finished = target.finishReconnectReplay(token, chatId);
		if (finished === 'stale') return { kind: 'superseded' };
		if (finished !== 'applied') return snapshotRequired('apply-failed');

		const cursor = target.transcriptCache.readAppliedCursor(chatId);
		if (
			!cursor ||
			cursor.stale ||
			cursor.transcriptViewId !== plan.transcriptViewId ||
			cursor.lastOrdinal < page.throughOrdinal
		) {
			return snapshotRequired('apply-failed');
		}
		target.transcriptCache.markValidated(chatId);
		return {
			kind: 'resumed',
			transcriptViewId: plan.transcriptViewId,
			throughOrdinal: page.throughOrdinal,
			deliveredMessages: page.messages.length,
			transientFeed: page.transientFeed,
		};
	} finally {
		target.abortReconnectReplay(token, chatId);
	}
}

// Shares one catch-up per chat across panel restores and activation. A request without a
// purpose joins any pending catch-up; an activation replaces one without it so its native
// drift probe is not lost.
export class CachedTranscriptResumes {
	readonly #pending = new Map<
		string,
		{ readonly purpose: TranscriptReadPurpose | undefined; readonly promise: Promise<CachedTranscriptResumeResult> }
	>();

	constructor(
		private readonly target: CachedTranscriptResumeTarget,
		private readonly readPage: TranscriptReplayPageReader,
	) {}

	// Returns null when only a snapshot can restore the chat.
	resume(
		chatId: string,
		options: { purpose?: TranscriptReadPurpose } = {},
	): Promise<CachedTranscriptResumeResult> | null {
		const pending = this.#pending.get(chatId);
		if (pending && (options.purpose === undefined || pending.purpose === options.purpose)) {
			return pending.promise;
		}
		const plan = planCachedTranscriptResume(this.target.transcriptCache.readAppliedCursor(chatId));
		if (plan.kind === 'snapshot') return null;
		const operation = {
			purpose: options.purpose,
			promise: resumeCachedTranscript({
				chatId,
				plan,
				purpose: options.purpose,
				target: this.target,
				readPage: this.readPage,
			}).finally(() => {
				if (this.#pending.get(chatId) === operation) this.#pending.delete(chatId);
			}),
		};
		this.#pending.set(chatId, operation);
		return operation.promise;
	}

	forget(chatId: string): void {
		this.#pending.delete(chatId);
	}

	clear(): void {
		this.#pending.clear();
	}
}

function replayFailureReason(error: unknown): CachedTranscriptSnapshotReason {
	if (!(error instanceof WsRequestError)) return 'replay-failed';
	if (error.code === 'STALE_TRANSCRIPT_VIEW') return 'view-replaced';
	// The server rejects a cursor ahead of its current view, such as after a ledger restore.
	if (error.code === 'REQUEST_VALIDATION_FAILED') return 'cursor-rejected';
	return 'replay-failed';
}
