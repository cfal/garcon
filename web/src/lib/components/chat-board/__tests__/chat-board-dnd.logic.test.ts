import { describe, expect, it } from 'vitest';
import {
	CHAT_BOARD_CARD_DRAG_TYPE,
	CHAT_BOARD_COLUMN_DROP_TYPE,
	getChatBoardCardDragData,
	isChatBoardCardDragData,
	isChatBoardColumnDropData,
} from '../chat-board-dnd';

describe('Chat Board drag data', () => {
	it('creates occurrence-safe card data and rejects malformed payloads', () => {
		const data = getChatBoardCardDragData({
			instanceId: 'instance',
			boardId: 'board',
			sourceColumnId: 'source',
			chatId: 'chat',
		});
		expect(data.type).toBe(CHAT_BOARD_CARD_DRAG_TYPE);
		expect(isChatBoardCardDragData(data)).toBe(true);
		expect(isChatBoardCardDragData({ ...data, chatId: 1 })).toBe(false);
	});

	it('accepts only complete column target data', () => {
		expect(
			isChatBoardColumnDropData({
				type: CHAT_BOARD_COLUMN_DROP_TYPE,
				instanceId: 'instance',
				boardId: 'board',
				columnId: 'column',
			}),
		).toBe(true);
		expect(isChatBoardColumnDropData({ type: CHAT_BOARD_COLUMN_DROP_TYPE })).toBe(false);
	});
});
