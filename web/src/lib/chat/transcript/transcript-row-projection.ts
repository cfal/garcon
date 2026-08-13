import type { TranscriptMessage } from '$shared/chat-view';
import { UserMessage, type ChatMessage } from '$shared/chat-types';
import type { LocalNoticeRow } from './local-notice.js';
import type { OptimisticUserInput } from './optimistic-user-input.js';
import { responseMessageType } from './conversation-feed-mutations.js';

export interface ChatTranscriptRow {
	kind: 'message';
	id: string;
	message: ChatMessage;
	ordinal?: number;
}

export type ChatDisplayRow = ChatTranscriptRow | LocalNoticeRow;

function optimisticInputToRow(input: OptimisticUserInput): ChatTranscriptRow {
	return {
		kind: 'message',
		id: `optimistic:${input.clientMessageId}`,
		message: new UserMessage(input.createdAt, input.content, input.images, {
			clientMessageId: input.clientMessageId,
		}),
	};
}

export function mergeRowsWithOptimisticInputs(
	rows: readonly ChatTranscriptRow[],
	optimisticInputs: readonly OptimisticUserInput[],
): ChatTranscriptRow[] {
	if (rows.length === 0) return optimisticInputs.map(optimisticInputToRow);

	const optimisticRows = optimisticInputs.map(optimisticInputToRow);
	const merged: ChatTranscriptRow[] = [];
	let messageIndex = 0;
	let optimisticIndex = 0;

	while (messageIndex < rows.length && optimisticIndex < optimisticRows.length) {
		const row = rows[messageIndex];
		const optimistic = optimisticRows[optimisticIndex];
		if (row.message.timestamp.localeCompare(optimistic.message.timestamp) < 0) {
			merged.push(row);
			messageIndex += 1;
		} else {
			merged.push(optimistic);
			optimisticIndex += 1;
		}
	}

	if (messageIndex < rows.length) merged.push(...rows.slice(messageIndex));
	if (optimisticIndex < optimisticRows.length) merged.push(...optimisticRows.slice(optimisticIndex));
	return merged;
}

export function echoedClientMessageIds(entries: readonly TranscriptMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const message = entry.message;
		if (message instanceof UserMessage && message.metadata?.clientMessageId) {
			ids.add(message.metadata.clientMessageId);
		}
	}
	return ids;
}

export function responseMessageTypesAfter(
	entries: readonly TranscriptMessage[],
	ordinal: number,
): string[] {
	return entries.flatMap((entry) => {
		if (entry.ordinal <= ordinal) return [];
		const type = responseMessageType(entry.message);
		return type ? [type] : [];
	});
}

export function transcriptDisplayRows(input: {
	readonly entries: readonly TranscriptMessage[];
	readonly transcriptViewId: string;
	readonly optimisticInputs: OptimisticUserInput[];
	readonly notices: readonly LocalNoticeRow[];
}): ChatDisplayRow[] {
	const durableRows = durableRowsFor(input.entries, input.transcriptViewId);
	const messages = input.optimisticInputs.length === 0
		? durableRows
		: mergeRowsWithOptimisticInputs(durableRows, input.optimisticInputs);
	return input.notices.length === 0 ? messages : [...messages, ...input.notices];
}

export function visibleTranscriptRows(input: {
	readonly entries: readonly TranscriptMessage[];
	readonly transcriptViewId: string;
	readonly optimisticInputs: OptimisticUserInput[];
	readonly notices: readonly LocalNoticeRow[];
	readonly visibleCount: number;
}): ChatDisplayRow[] {
	const noticeCount = Math.min(input.notices.length, input.visibleCount);
	const visibleNotices = input.notices.slice(-noticeCount);
	const messageLimit = input.visibleCount - noticeCount;
	if (messageLimit === 0) return visibleNotices;

	const durableRows = durableRowsFor(input.entries.slice(-messageLimit), input.transcriptViewId);
	const messageRows = input.optimisticInputs.length === 0
		? durableRows
		: mergeRowsWithOptimisticInputs(durableRows, input.optimisticInputs).slice(-messageLimit);
	return [...messageRows, ...visibleNotices];
}

export function messagesFromDisplayRows(rows: readonly ChatDisplayRow[]): ChatMessage[] {
	return rows.flatMap((row) => (row.kind === 'message' ? [row.message] : []));
}

function durableRowsFor(
	entries: readonly TranscriptMessage[],
	transcriptViewId: string,
): ChatTranscriptRow[] {
	return entries.map((entry) => ({
		kind: 'message',
		id: `${transcriptViewId}:${entry.ordinal}`,
		ordinal: entry.ordinal,
		message: entry.message,
	}));
}
