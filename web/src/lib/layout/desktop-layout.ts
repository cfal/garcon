export type ChatListDock = 'left' | 'right';
export type DesktopLayoutEdge = 'start' | 'end';

export const DEFAULT_CHAT_LIST_DOCK: ChatListDock = 'left';

const LEGACY_DESKTOP_LAYOUT_PANES = ['chat-list', 'main', 'workspace-sidebar'] as const;
const LEGACY_DESKTOP_LAYOUT_PANE_SET: ReadonlySet<string> = new Set(
	LEGACY_DESKTOP_LAYOUT_PANES,
);

// Accepts the current dock value or the legacy three-pane order array, which
// is reduced to the side the chat list was docked on.
export function normalizeChatListDock(value: unknown): ChatListDock {
	if (value === 'left' || value === 'right') return value;
	if (
		Array.isArray(value) &&
		value.length === LEGACY_DESKTOP_LAYOUT_PANES.length &&
		value.every(
			(entry): entry is (typeof LEGACY_DESKTOP_LAYOUT_PANES)[number] =>
				typeof entry === 'string' && LEGACY_DESKTOP_LAYOUT_PANE_SET.has(entry),
		) &&
		new Set(value).size === LEGACY_DESKTOP_LAYOUT_PANES.length
	) {
		const order = value;
		const chatListIndex = order.indexOf('chat-list');
		const mainIndex = order.indexOf('main');
		return chatListIndex > mainIndex ? 'right' : 'left';
	}
	return DEFAULT_CHAT_LIST_DOCK;
}

// Edge of the chat-list pane that carries the divider and border.
export function chatListDividerEdge(dock: ChatListDock): DesktopLayoutEdge {
	return dock === 'left' ? 'end' : 'start';
}
