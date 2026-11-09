import type {
	ResendCandidate,
	TranscriptMessage,
	TranscriptPage,
	UnavailableChatHistoryResponse,
} from '$shared/chat-view';
import {
	isCompleteTranscriptAnchorResponse,
	isTranscriptAnchor,
	transcriptAnchorContinuation,
	transcriptAnchorWindow,
	TRANSCRIPT_ANCHOR_RAW_LIMIT,
	type TranscriptAnchorPage,
	type TranscriptAnchorRequest,
	type TranscriptAnchorResponse,
} from '$shared/transcript-anchor-page';
import { getCombinedChatMessages } from '$lib/api/chats.js';
import { ApiError } from '$lib/api/client.js';

export type TranscriptAnchorChunkResult =
	| { kind: 'complete'; page: TranscriptAnchorPage }
	| { kind: 'unavailable'; response: UnavailableChatHistoryResponse }
	| { kind: 'view-changed'; transcriptViewId?: string }
	| { kind: 'cursor-ahead'; transcriptViewId?: string }
	| { kind: 'invalidated' };

export async function loadTranscriptAnchorChunk(
	request: TranscriptAnchorRequest,
	isCurrent: () => boolean,
	loadPage = getCombinedChatMessages,
): Promise<TranscriptAnchorChunkResult> {
	let response: TranscriptAnchorResponse;
	try {
		response = await loadPage(request);
	} catch (error) {
		if (!isCurrent()) return { kind: 'invalidated' };
		if (error instanceof ApiError) {
			if (error.errorCode === 'STALE_TRANSCRIPT_VIEW')
				return { kind: 'view-changed', transcriptViewId: request.transcriptViewId };
			if (error.errorCode === 'TRANSCRIPT_CURSOR_AHEAD')
				return { kind: 'cursor-ahead', transcriptViewId: request.transcriptViewId };
		}
		throw error;
	}
	if (!isCurrent()) return { kind: 'invalidated' };
	return isCompleteTranscriptAnchorResponse(response)
		? { kind: 'complete', page: response }
		: { kind: 'unavailable', response };
}

export interface TranscriptAnchorSnapshot {
	page: TranscriptPage & { resendCandidates: ResendCandidate[] };
	finalChunk: TranscriptAnchorPage;
}

export type TranscriptAnchorSnapshotResult =
	| ({ kind: 'complete' } & TranscriptAnchorSnapshot)
	| Exclude<TranscriptAnchorChunkResult, { kind: 'complete' }>;

export async function loadTranscriptAnchorSnapshot(options: {
	request: TranscriptAnchorRequest;
	isCurrent: () => boolean;
	isDisjoint?: (page: TranscriptPage) => boolean;
	loadPage?: typeof getCombinedChatMessages;
}): Promise<TranscriptAnchorSnapshotResult> {
	let request = options.request;
	let accumulated: TranscriptAnchorSnapshot['page'] | undefined;
	while (options.isCurrent()) {
		const result = await loadTranscriptAnchorChunk(request, options.isCurrent, options.loadPage);
		if (result.kind !== 'complete') return result;
		const chunk = result.page;
		if (!accumulated) {
			accumulated = { ...transcriptAnchorWindow(chunk), resendCandidates: chunk.resendCandidates };
		} else if (chunk.startOrdinal < chunk.endOrdinal) {
			const backward = chunk.direction === 'backward';
			const messages = backward
				? [...chunk.messages, ...accumulated.messages]
				: [...accumulated.messages, ...chunk.messages];
			let nextBeforeOrdinal = accumulated.nextBeforeOrdinal;
			if (backward) nextBeforeOrdinal = chunk.startOrdinal > 1 ? chunk.startOrdinal : null;
			accumulated = {
				...accumulated,
				messages,
				nextBeforeOrdinal,
				hasMore: nextBeforeOrdinal !== null,
				pageNewestOrdinal: backward ? accumulated.pageNewestOrdinal : chunk.endOrdinal - 1,
				pageOldestOrdinal: messages[0]?.ordinal ?? 0,
			};
		}
		const rawCount = accumulated.pageNewestOrdinal + 1 - (accumulated.nextBeforeOrdinal ?? 1);
		const continuation = transcriptAnchorContinuation(chunk);
		const shouldAccumulate = continuation && (
			accumulated.messages.length === 0 ||
			(rawCount < TRANSCRIPT_ANCHOR_RAW_LIMIT && options.isDisjoint?.(accumulated))
		);
		if (!shouldAccumulate) return { kind: 'complete', page: accumulated, finalChunk: chunk };
		request = continuation;
	}
	return { kind: 'invalidated' };
}

export function countTranscriptAnchors(
	entries: readonly TranscriptMessage[],
	before = Infinity,
): number {
	let anchors = 0;
	for (const entry of entries) {
		if (entry.ordinal >= before) break;
		if (isTranscriptAnchor(entry.message)) anchors += 1;
	}
	return anchors;
}
