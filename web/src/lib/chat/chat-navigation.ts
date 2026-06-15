import { goto } from '$app/navigation';

const CHAT_NAVIGATION_OPTIONS = { keepFocus: true } as const;

export function gotoChat(chatId: string): Promise<void> {
	return goto(`/chat/${chatId}`, CHAT_NAVIGATION_OPTIONS);
}
