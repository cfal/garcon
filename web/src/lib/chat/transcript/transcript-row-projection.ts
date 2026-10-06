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
		const rowPrecedesOptimistic = row.ordinal !== undefined
			&& (optimistic.afterOrdinal === undefined || row.ordinal <= optimistic.afterOrdinal);
		if (rowPrecedesOptimistic) {
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

export function echoedClientMessageOrdinals(
	entries: readonly TranscriptMessage[],
): Map<string, number> {
	const ordinals = new Map<string, number>();
	for (const entry of entries) {
		const message = entry.message;
		if (message instanceof UserMessage && message.metadata?.clientMessageId) {
			ordinals.set(message.metadata.clientMessageId, entry.ordinal);
		}
	}
	return ordinals;
}

export function visibleOptimisticTranscriptInputs(
	hasLaterMessages: boolean,
	inputs: readonly OptimisticUserInput[],
	echoedIds: ReadonlySet<string>,
): OptimisticUserInput[] {
	if (hasLaterMessages) return [];
	return inputs.filter((input) => !echoedIds.has(input.clientMessageId));
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
