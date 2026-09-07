import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatBoard, ChatBoardColumn } from '$shared/chat-boards';

export interface ChatBoardOccurrence {
	readonly key: string;
	readonly columnId: string;
	readonly chat: ChatSessionRecord;
}

export interface ChatBoardLaneProjection {
	readonly column: ChatBoardColumn;
	readonly occurrences: readonly ChatBoardOccurrence[];
	readonly processingCount: number;
}

export function projectChatBoard(
	board: ChatBoard,
	orderedChats: readonly ChatSessionRecord[],
): readonly ChatBoardLaneProjection[] {
	const columnCount = board.columns.length;
	const occurrences = board.columns.map(() => [] as ChatBoardOccurrence[]);
	const processingCounts = new Uint32Array(columnCount);
	const columnsByTag = new Map<string, { all: number[]; any: number[] }>();

	for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
		const column = board.columns[columnIndex];
		for (const tag of column.tags) {
			let targets = columnsByTag.get(tag);
			if (!targets) {
				targets = { all: [], any: [] };
				columnsByTag.set(tag, targets);
			}
			targets[column.match].push(columnIndex);
		}
	}

	const matchCounts = new Uint8Array(columnCount);
	for (const chat of orderedChats) {
		if (chat.status === 'draft' || chat.isArchived) continue;
		matchCounts.fill(0);
		for (const tag of chat.tags) {
			const targets = columnsByTag.get(tag);
			if (!targets) continue;
			for (const columnIndex of targets.all) matchCounts[columnIndex] += 1;
			for (const columnIndex of targets.any) matchCounts[columnIndex] = 255;
		}
		for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
			const column = board.columns[columnIndex];
			const matches =
				column.tags.length > 0 &&
				(column.match === 'all'
					? matchCounts[columnIndex] === column.tags.length
					: matchCounts[columnIndex] === 255);
			if (!matches) continue;
			occurrences[columnIndex].push({
				key: `${column.id}:${chat.id}`,
				columnId: column.id,
				chat,
			});
			if (chat.isProcessing) processingCounts[columnIndex] += 1;
		}
	}

	return board.columns.map((column, columnIndex) => ({
		column,
		occurrences: occurrences[columnIndex],
		processingCount: processingCounts[columnIndex],
	}));
}
