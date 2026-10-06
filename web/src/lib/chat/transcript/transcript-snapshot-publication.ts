import type { ResendCandidate, TranscriptPage } from '$shared/chat-view';
import type { ChatTranscriptSnapshot } from './chat-transcript-cache.svelte.js';
import type { TranscriptPageDirection, TranscriptPageState } from './transcript-page-progress.js';

export type ActiveTranscriptSnapshot = TranscriptPage & {
	resendCandidates?: ResendCandidate[];
	boundedBeforeOrdinal?: number | null;
};

export interface TranscriptSnapshotPublication {
	chatId: string;
	transcriptViewId: string;
	lastOrdinal: number;
	boundedBeforeOrdinal: number | null;
}

interface ContinuationHost {
	activeChatId: string | null;
	transcriptViewId: string;
	nextBeforeOrdinal: number | null;
	loadedThroughOrdinal: number;
	hasEarlierMessages: boolean;
	hasLaterMessages: boolean;
	pageStates: Record<TranscriptPageDirection, TranscriptPageState>;
}

interface ManualContinuations {
	chatId: string | null;
	transcriptViewId: string;
	earlier: number | null;
	later: number | null;
}

export function captureManualContinuations(host: ContinuationHost): ManualContinuations {
	const manual = (direction: TranscriptPageDirection) => host.pageStates[direction].status === 'bounded'
		|| host.pageStates[direction].continuation === 'manual';
	return {
		chatId: host.activeChatId, transcriptViewId: host.transcriptViewId,
		earlier: manual('earlier') ? host.nextBeforeOrdinal : null,
		later: manual('later') ? host.loadedThroughOrdinal : null,
	};
}

export function restoreManualContinuations(host: ContinuationHost, prior: ManualContinuations): void {
	if (host.activeChatId !== prior.chatId || host.transcriptViewId !== prior.transcriptViewId) return;
	if (host.hasEarlierMessages && prior.earlier !== null && prior.earlier === host.nextBeforeOrdinal) {
		host.pageStates.earlier = { status: 'bounded', error: null };
	}
	if (host.hasLaterMessages && prior.later !== null && prior.later === host.loadedThroughOrdinal) {
		host.pageStates.later = { status: 'bounded', error: null };
	}
}

export function cachedSnapshotPage(
	chatId: string,
	snapshot: ChatTranscriptSnapshot,
	source: ContinuationHost & { lastOrdinal: number; snapshotPublication: TranscriptSnapshotPublication | null },
): ActiveTranscriptSnapshot {
	const matches = source.activeChatId === chatId && source.transcriptViewId === snapshot.transcriptViewId;
	const publication = source.snapshotPublication?.chatId === chatId
		&& source.snapshotPublication.transcriptViewId === snapshot.transcriptViewId ? source.snapshotPublication : null;
	return {
		transcriptViewId: snapshot.transcriptViewId, messages: snapshot.messages,
		lastOrdinal: Math.max(snapshot.lastOrdinal, matches ? source.lastOrdinal : 0, publication?.lastOrdinal ?? 0),
		pageOldestOrdinal: snapshot.oldestOrdinal, pageNewestOrdinal: snapshot.lastOrdinal,
		nextBeforeOrdinal: snapshot.nextBeforeOrdinal, hasMore: snapshot.nextBeforeOrdinal !== null,
		boundedBeforeOrdinal: publication?.boundedBeforeOrdinal ?? null,
	};
}
