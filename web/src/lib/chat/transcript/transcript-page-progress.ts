import type { ChatViewMessage } from '$shared/chat-view';

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
	entries: ChatViewMessage[],
	edge: 'earlier' | 'later',
): ChatViewMessage[] {
	if (entries.length <= ACTIVE_TRANSCRIPT_RETENTION_LIMIT) return entries;
	return edge === 'earlier'
		? entries.slice(0, ACTIVE_TRANSCRIPT_RETENTION_LIMIT)
		: entries.slice(-ACTIVE_TRANSCRIPT_RETENTION_LIMIT);
}

export function collectEarlierTranscriptMessages(
	currentOldestSeq: number,
	pageMessages: readonly ChatViewMessage[],
): ChatViewMessage[] {
	const pageSeqs = new Set<number>();
	return pageMessages.filter((message) => {
		if (message.seq >= currentOldestSeq || pageSeqs.has(message.seq)) return false;
		pageSeqs.add(message.seq);
		return true;
	});
}
