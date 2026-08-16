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
	awaitingDelivery?: boolean;
}

export type ChatDisplayRow = ChatTranscriptRow | LocalNoticeRow;

function optimisticInputToRow(input: OptimisticUserInput): ChatTranscriptRow {
	return {
		kind: 'message',
		id: `optimistic:${input.clientMessageId}`,
		message: new UserMessage(input.createdAt, input.content, input.images, {
			clientMessageId: input.clientMessageId,
		}),
		...(input.delivery === 'pending' ? { awaitingDelivery: true } : {}),
	};
}

export function mergeRowsWithOptimisticInputs(
	rows: readonly ChatTranscriptRow[],
	optimisticInputs: readonly OptimisticUserInput[],
	afterOrdinalByClientMessageId: ReadonlyMap<string, number>,
): ChatTranscriptRow[] {
	if (rows.length === 0) return optimisticInputs.map(optimisticInputToRow);

	const optimisticRows = optimisticInputs.map((input) => ({
		row: optimisticInputToRow(input),
		afterOrdinal: afterOrdinalByClientMessageId.get(input.clientMessageId),
	}));
	const merged: ChatTranscriptRow[] = [];
	let messageIndex = 0;
	let optimisticIndex = 0;

	while (messageIndex < rows.length && optimisticIndex < optimisticRows.length) {
		const row = rows[messageIndex];
		const optimistic = optimisticRows[optimisticIndex];
		const timestampOrder = row.message.timestamp.localeCompare(optimistic.row.message.timestamp);
		const rowPrecedesEqualTimestamp = optimistic.afterOrdinal !== undefined
			&& row.ordinal !== undefined
			&& row.ordinal <= optimistic.afterOrdinal;
		if (timestampOrder < 0 || (timestampOrder === 0 && rowPrecedesEqualTimestamp)) {
			merged.push(row);
			messageIndex += 1;
		} else {
			merged.push(optimistic.row);
			optimisticIndex += 1;
		}
	}

	if (messageIndex < rows.length) merged.push(...rows.slice(messageIndex));
	if (optimisticIndex < optimisticRows.length) {
		merged.push(...optimisticRows.slice(optimisticIndex).map(({ row }) => row));
	}
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

export function visibleOptimisticTranscriptInputs(
	hasLaterMessages: boolean,
	inputs: readonly OptimisticUserInput[],
	echoedIds: ReadonlySet<string>,
): OptimisticUserInput[] {
	if (hasLaterMessages) return [];
	return inputs.filter((input) => !echoedIds.has(input.clientMessageId));
}

export function hasEarlierTranscriptRowsToReveal(
	visibleRows: readonly ChatDisplayRow[],
	entries: readonly TranscriptMessage[],
): boolean {
	const firstVisibleOrdinal = visibleRows.find(
		(row): row is ChatTranscriptRow => row.kind === 'message' && row.ordinal !== undefined,
	)?.ordinal;
	return firstVisibleOrdinal !== undefined
		&& (entries[0]?.ordinal ?? firstVisibleOrdinal) < firstVisibleOrdinal;
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
	readonly optimisticAfterOrdinals: ReadonlyMap<string, number>;
	readonly notices: readonly LocalNoticeRow[];
}): ChatDisplayRow[] {
	const durableRows = durableRowsFor(input.entries, input.transcriptViewId);
	const messages = input.optimisticInputs.length === 0
		? durableRows
		: mergeRowsWithOptimisticInputs(
			durableRows,
			input.optimisticInputs,
			input.optimisticAfterOrdinals,
		);
	return input.notices.length === 0 ? messages : [...messages, ...input.notices];
}

export function visibleTranscriptRows(input: {
	readonly entries: readonly TranscriptMessage[];
	readonly transcriptViewId: string;
	readonly optimisticInputs: OptimisticUserInput[];
	readonly optimisticAfterOrdinals: ReadonlyMap<string, number>;
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
		: mergeRowsWithOptimisticInputs(
			durableRows,
			input.optimisticInputs,
			input.optimisticAfterOrdinals,
		).slice(-messageLimit);
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
