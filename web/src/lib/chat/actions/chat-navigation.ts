import { goto } from '$app/navigation';
import { resolve } from '$app/paths';

const CHAT_NAVIGATION_OPTIONS = { reset: false } as const;

export function gotoChat(chatId: string): Promise<void> {
	return goto(resolve('/chat/[id]', { id: chatId }), CHAT_NAVIGATION_OPTIONS);
}
