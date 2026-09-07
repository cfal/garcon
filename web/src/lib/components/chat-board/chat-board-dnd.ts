export const CHAT_BOARD_CARD_DRAG_TYPE = 'chat-board-card';
export const CHAT_BOARD_COLUMN_DROP_TYPE = 'chat-board-column';

export interface ChatBoardCardDragData {
	readonly type: typeof CHAT_BOARD_CARD_DRAG_TYPE;
	readonly instanceId: string;
	readonly boardId: string;
	readonly sourceColumnId: string;
	readonly chatId: string;
}

export interface ChatBoardColumnDropData {
	readonly type: typeof CHAT_BOARD_COLUMN_DROP_TYPE;
	readonly instanceId: string;
	readonly boardId: string;
	readonly columnId: string;
}

export function getChatBoardCardDragData(
	data: Omit<ChatBoardCardDragData, 'type'>,
): ChatBoardCardDragData {
	return { type: CHAT_BOARD_CARD_DRAG_TYPE, ...data };
}

export function isChatBoardCardDragData(value: unknown): value is ChatBoardCardDragData {
	if (!value || typeof value !== 'object') return false;
	const data = value as Record<string, unknown>;
	return (
		data.type === CHAT_BOARD_CARD_DRAG_TYPE &&
		typeof data.instanceId === 'string' &&
		typeof data.boardId === 'string' &&
		typeof data.sourceColumnId === 'string' &&
		typeof data.chatId === 'string'
	);
}

export function isChatBoardColumnDropData(value: unknown): value is ChatBoardColumnDropData {
	if (!value || typeof value !== 'object') return false;
	const data = value as Record<string, unknown>;
	return (
		data.type === CHAT_BOARD_COLUMN_DROP_TYPE &&
		typeof data.instanceId === 'string' &&
		typeof data.boardId === 'string' &&
		typeof data.columnId === 'string'
	);
}
