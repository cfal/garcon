export function selectedChatIdFromRoute(pathname: string, chatId: string | undefined): string | null | undefined {
	if (chatId) return chatId;
	if (pathname === '/' || pathname === '/chat' || pathname === '/chat/') return null;
	return undefined;
}
