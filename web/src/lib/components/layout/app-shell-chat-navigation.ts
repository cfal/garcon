import type { SidebarVirtualRow } from '$lib/sidebar/display/sidebar-virtual-chat-list';
import { sidebarScrollTargetForChat } from '../sidebar/sidebar-chat-list-dom';

export function resolveAdjacentChatId(input: {
	selectedChatId: string | null;
	displayedChatIds: readonly string[] | null;
	displayedRows?: readonly SidebarVirtualRow[];
	fallbackOrder: readonly string[];
	offset: -1 | 1;
}): string | null {
	const { selectedChatId, displayedChatIds, fallbackOrder, offset } = input;
	if (!selectedChatId) return null;
	const order = displayedChatIds ?? fallbackOrder;
	const anchor = input.displayedRows
		? sidebarScrollTargetForChat(input.displayedRows, selectedChatId)?.chatId ?? selectedChatId
		: selectedChatId;
	const index = order.indexOf(anchor);
	if (index < 0) return null;
	return order[index + offset] ?? null;
}

export function shouldSynchronizeFocusedChat(input: {
	focusedWindowId: string;
	focusedChatId: string | null;
	focusedChatExists: boolean;
	selectedChatId: string | null;
	pendingChatTarget: string | null;
	pendingWindowId: string | null;
}): boolean {
	if (input.focusedChatId === null || !input.focusedChatExists) return false;
	if (input.focusedChatId === input.selectedChatId) return false;
	if (input.pendingChatTarget === null) return true;
	return (
		input.pendingWindowId !== input.focusedWindowId &&
		input.pendingChatTarget !== input.focusedChatId
	);
}
