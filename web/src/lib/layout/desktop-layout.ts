export type ChatListDock = 'left' | 'right';
export type DesktopLayoutEdge = 'start' | 'end';

export const DEFAULT_CHAT_LIST_DOCK: ChatListDock = 'left';
export const HOVER_CAPABLE_MEDIA_QUERY = '(hover: hover)';

export function normalizeChatListDock(value: unknown): ChatListDock {
	if (value === 'left' || value === 'right') return value;
	return DEFAULT_CHAT_LIST_DOCK;
}

// Selects the chat-list edge that carries the divider and border.
export function chatListDividerEdge(dock: ChatListDock): DesktopLayoutEdge {
	return dock === 'left' ? 'end' : 'start';
}
