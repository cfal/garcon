export function resolveArchiveReplacementChatId(input: {
	archivingChatId: string;
	displayedChatIds: readonly string[];
	isSelectableChat: (chatId: string) => boolean;
}): string | null {
	const { archivingChatId, displayedChatIds, isSelectableChat } = input;
	const archivingChatIndex = displayedChatIds.indexOf(archivingChatId);
	if (archivingChatIndex === -1) return null;

	for (let index = archivingChatIndex + 1; index < displayedChatIds.length; index += 1) {
		const chatId = displayedChatIds[index];
		if (chatId && isSelectableChat(chatId)) return chatId;
	}
	for (let index = archivingChatIndex - 1; index >= 0; index -= 1) {
		const chatId = displayedChatIds[index];
		if (chatId && isSelectableChat(chatId)) return chatId;
	}
	return null;
}
