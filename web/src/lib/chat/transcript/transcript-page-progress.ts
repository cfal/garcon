import type { TranscriptMessage } from '$shared/chat-view';

export type TranscriptPageLoadResult = 'loaded' | 'exhausted' | 'invalidated' | 'failed';
export type TranscriptPageDirection = 'earlier' | 'later';
export type TranscriptPageApplicationDecision = 'apply' | 'invalidated';
export type TranscriptPageApplicationGate = () => Promise<TranscriptPageApplicationDecision>;
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

export function retainedEarlierPageCursor(
	sourceMessages: readonly TranscriptMessage[],
	retainedMessages: readonly TranscriptMessage[],
	nextBeforeOrdinal: number | null,
): number | null {
	return retainedMessages.length < sourceMessages.length
		? retainedMessages[0]?.ordinal ?? null
		: nextBeforeOrdinal;
}

export function mergeTranscriptEntriesByOrdinal(
	current: TranscriptMessage[],
	incoming: TranscriptMessage[],
): TranscriptMessage[] {
	if (incoming.length === 0) return current;

	const merged: TranscriptMessage[] = [];
	let currentIndex = 0;
	let incomingIndex = 0;
	let changed = false;
	while (currentIndex < current.length || incomingIndex < incoming.length) {
		const currentEntry = current[currentIndex];
		const incomingEntry = incoming[incomingIndex];
		if (!currentEntry) {
			merged.push(incomingEntry!);
			incomingIndex += 1;
			changed = true;
			continue;
		}
		if (!incomingEntry) {
			merged.push(currentEntry);
			currentIndex += 1;
			continue;
		}
		if (currentEntry.ordinal <= incomingEntry.ordinal) {
			merged.push(currentEntry);
			currentIndex += 1;
			if (currentEntry.ordinal === incomingEntry.ordinal) incomingIndex += 1;
			continue;
		}
		merged.push(incomingEntry);
		incomingIndex += 1;
		changed = true;
	}
	return changed ? merged : current;
}
