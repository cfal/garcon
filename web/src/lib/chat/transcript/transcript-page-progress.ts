import type { TranscriptMessage, TranscriptPage } from '$shared/chat-view';

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

export function validateEarlierTranscriptPage(
	page: Pick<
		TranscriptPage,
		'hasMore' | 'lastOrdinal' | 'messages' | 'pageOldestOrdinal' | 'pageNewestOrdinal'
	>,
	currentOldestOrdinal: number,
): void {
	if (page.pageNewestOrdinal !== currentOldestOrdinal - 1) {
		throw new Error('Earlier transcript page did not advance the loaded window');
	}
	if (
		page.pageOldestOrdinal > page.pageNewestOrdinal
		|| page.pageNewestOrdinal > page.lastOrdinal
	) {
		throw new Error('Earlier transcript page has invalid ordinal bounds');
	}
	if (page.messages.length === 0) {
		if (page.pageOldestOrdinal !== 0 || page.hasMore) {
			throw new Error('Earlier transcript page did not advance the loaded window');
		}
		return;
	}
	if (page.messages[0]?.ordinal !== page.pageOldestOrdinal) {
		throw new Error('Earlier transcript page has an invalid oldest message');
	}
	let previousOrdinal = 0;
	for (const message of page.messages) {
		if (
			!Number.isSafeInteger(message.ordinal)
			|| message.ordinal <= previousOrdinal
			|| message.ordinal < page.pageOldestOrdinal
			|| message.ordinal > page.pageNewestOrdinal
		) {
			throw new Error('Earlier transcript page has invalid message ordinals');
		}
		previousOrdinal = message.ordinal;
	}
}
