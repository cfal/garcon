export function isBareChatRoute(pathname: string): boolean {
	return pathname === '/' || pathname === '/chat' || pathname === '/chat/';
}

export function selectedChatIdFromRoute(
	pathname: string,
	chatId: string | undefined,
): string | null | undefined {
	if (chatId) return chatId;
	if (isBareChatRoute(pathname)) return null;
	return undefined;
}

export function restoreChatIdForBareRoute(input: {
	pathname: string;
	routeChatId: string | undefined;
	isLoadingChats: boolean;
	lastSelectedChatId: string | null;
	selectedChatId: string | null;
}): string | null {
	if (!isBareChatRoute(input.pathname)) return null;
	if (input.routeChatId) return null;
	if (input.isLoadingChats) return null;
	if (!input.lastSelectedChatId) return null;
	if (input.lastSelectedChatId === input.selectedChatId) return null;
	return input.lastSelectedChatId;
}
