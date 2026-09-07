export function resolveAdjacentChatId(input: {
	selectedChatId: string | null;
	displayedChatIds: readonly string[] | null;
	fallbackOrder: readonly string[];
	offset: -1 | 1;
}): string | null {
	const { selectedChatId, displayedChatIds, fallbackOrder, offset } = input;
	if (!selectedChatId) return null;
	const order = displayedChatIds ?? fallbackOrder;
	const index = order.indexOf(selectedChatId);
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
