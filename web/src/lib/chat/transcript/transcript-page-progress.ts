import type { TranscriptMessage } from '$shared/chat-view';

export type TranscriptPageLoadResult = 'loaded' | 'exhausted' | 'invalidated' | 'failed';
export type TranscriptPageDirection = 'earlier' | 'later';
export type TranscriptPageStatus = 'idle' | 'loading' | 'error';
export type TranscriptWindowLoadResult = 'loaded' | 'invalidated' | 'failed';
export type TranscriptWindowTarget = 'initial' | 'latest';

export interface TranscriptPageState {
	status: TranscriptPageStatus;
	error: string | null;
}

export const idlePageState = (): TranscriptPageState => ({ status: 'idle', error: null });

export const ACTIVE_TRANSCRIPT_RETENTION_LIMIT = 200;

export function retainTranscriptEntries(
	entries: TranscriptMessage[],
	edge: 'earlier' | 'later',
): TranscriptMessage[] {
	if (entries.length <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT) return entries;
	return edge === 'earlier'
		? entries.slice(0, ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
		: entries.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
}

export function collectEarlierTranscriptMessages(
	currentOldestSeq: number,
	pageMessages: readonly TranscriptMessage[],
): TranscriptMessage[] {
	const pageSeqs = new Set<number>();
	return pageMessages.filter((message) => {
		if (message.ordinal >= currentOldestSeq || pageSeqs.has(message.ordinal)) return false;
		pageSeqs.add(message.ordinal);
		return true;
	});
}
