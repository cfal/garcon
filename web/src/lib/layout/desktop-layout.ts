export type ChatListDock = 'left' | 'right';
export type DesktopLayoutEdge = 'start' | 'end';

export const DEFAULT_CHAT_LIST_DOCK: ChatListDock = 'left';

const LEGACY_DESKTOP_LAYOUT_PANES = ['chat-list', 'main', 'workspace-sidebar'] as const;

// Accepts the current dock value or the legacy three-pane order array, which
// is reduced to the side the chat list was docked on.
export function normalizeChatListDock(value: unknown): ChatListDock {
	if (value === 'left' || value === 'right') return value;
	if (Array.isArray(value)) {
		const order = value.filter((entry): entry is string => typeof entry === 'string');
		const chatListIndex = order.indexOf('chat-list');
		const mainIndex = order.indexOf('main');
		if (
			chatListIndex >= 0 &&
			mainIndex >= 0 &&
			order.every((entry) =>
				(LEGACY_DESKTOP_LAYOUT_PANES as readonly string[]).includes(entry),
			)
		) {
			return chatListIndex > mainIndex ? 'right' : 'left';
		}
	}
	return DEFAULT_CHAT_LIST_DOCK;
}

// Edge of the chat-list pane that carries the divider and border.
export function chatListDividerEdge(dock: ChatListDock): DesktopLayoutEdge {
	return dock === 'left' ? 'end' : 'start';
}
