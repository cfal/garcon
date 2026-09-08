import type { ChatBoard } from '$shared/chat-boards';

export function copyChatBoard(board: ChatBoard): ChatBoard {
	return {
		id: board.id,
		name: board.name,
		columns: board.columns.map((column) => ({
			id: column.id,
			name: column.name,
			match: column.match,
			tags: [...column.tags],
		})),
	};
}
