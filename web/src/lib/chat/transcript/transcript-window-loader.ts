import type {
	ResendCandidate,
	TranscriptPage,
} from '$shared/chat-view';
import type { ChatTranscriptSnapshot } from './chat-transcript-cache.svelte.js';
import {
	collapseBackwardTranscriptDemand,
	loadTranscriptPageDemand,
	type TranscriptPageDemandResult,
} from './transcript-page-demand.js';
import type { TranscriptWindowTarget } from './transcript-page-progress.js';

export type TranscriptWindowPage = TranscriptPage & {
	resendCandidates?: ResendCandidate[];
};

export type TranscriptSnapshotInstallMode = 'merge' | 'preserve-window' | 'replace';

export type TranscriptWindowPageResult =
	| { kind: 'complete'; page: TranscriptWindowPage }
	| Exclude<TranscriptPageDemandResult, { kind: 'complete' }>;

export async function loadTranscriptWindowPage(options: {
	chatId: string;
	target: TranscriptWindowTarget;
	transcriptViewId: string;
	lastOrdinal: number;
	visibleLimit: number;
	isCurrent: () => boolean;
}): Promise<TranscriptWindowPageResult> {
	const demand = await loadTranscriptPageDemand(
		options.target === 'initial'
			? {
					direction: 'later',
					chatId: options.chatId,
					transcriptViewId: options.transcriptViewId,
					afterOrdinal: 0,
					throughOrdinal: options.lastOrdinal,
					visibleLimit: options.visibleLimit,
					isCurrent: options.isCurrent,
				}
			: {
					direction: 'backward',
					chatId: options.chatId,
					transcriptViewId: options.transcriptViewId,
					visibleLimit: options.visibleLimit,
					isCurrent: options.isCurrent,
				},
	);
	if (demand.kind !== 'complete') return demand;
	if (options.target === 'latest') {
		return { kind: 'complete', page: collapseBackwardTranscriptDemand(demand) };
	}

	const firstPage = demand.pages[0];
	const finalPage = demand.pages.at(-1);
	if (!firstPage || !finalPage) {
		throw new Error('Initial transcript demand completed without a page');
	}
	return {
		kind: 'complete',
		page: {
			transcriptViewId: options.transcriptViewId,
			messages: demand.messages,
			lastOrdinal: Math.max(options.lastOrdinal, demand.lastOrdinal),
			pageOldestOrdinal: demand.messages[0]?.ordinal ?? 0,
			pageNewestOrdinal: finalPage.pageNewestOrdinal,
			nextBeforeOrdinal: null,
			hasMore: false,
			resendCandidates: firstPage.resendCandidates,
		},
	};
}

export function preferCachedLatestTranscriptPage(
	page: TranscriptWindowPage,
	cached: ChatTranscriptSnapshot | null,
	resendCandidates: readonly ResendCandidate[],
): TranscriptWindowPage {
	if (
		!cached
		|| cached.stale
		|| cached.transcriptViewId !== page.transcriptViewId
		|| cached.lastOrdinal <= page.lastOrdinal
	) return page;

	return {
		...page,
		messages: cached.messages,
		lastOrdinal: cached.lastOrdinal,
		pageOldestOrdinal: cached.oldestOrdinal,
		pageNewestOrdinal: cached.lastOrdinal,
		nextBeforeOrdinal: cached.nextBeforeOrdinal,
		hasMore: cached.nextBeforeOrdinal !== null,
		resendCandidates: [...resendCandidates],
	};
}

export function transcriptSnapshotInstallMode(options: {
	activeChatId: string | null;
	chatId: string;
	transcriptViewId: string;
	entryCount: number;
	loadedThroughOrdinal: number;
	nextBeforeOrdinal: number | null;
	page: TranscriptPage;
}): TranscriptSnapshotInstallMode {
	if (
		options.activeChatId !== options.chatId
		|| options.transcriptViewId === ''
		|| options.transcriptViewId !== options.page.transcriptViewId
		|| options.entryCount === 0
	) {
		return 'replace';
	}
	const pageRawStartOrdinal = options.page.pageNewestOrdinal === 0
		? 0
		: options.page.nextBeforeOrdinal ?? 1;
	const currentRawStartOrdinal = options.loadedThroughOrdinal === 0
		? 0
		: options.nextBeforeOrdinal ?? 1;
	const intervalsTouch = options.page.pageNewestOrdinal === 0 || options.loadedThroughOrdinal === 0
		? options.page.pageNewestOrdinal === options.loadedThroughOrdinal
		: pageRawStartOrdinal <= options.loadedThroughOrdinal + 1
			&& currentRawStartOrdinal <= options.page.pageNewestOrdinal + 1;
	return intervalsTouch ? 'merge' : 'preserve-window';
}
