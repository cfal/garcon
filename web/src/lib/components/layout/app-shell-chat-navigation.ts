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
