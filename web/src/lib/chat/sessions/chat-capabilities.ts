import type { ChatObservation } from '$shared/chat-observation';

export function canExecuteChat(chat: { observation: ChatObservation | null } | null | undefined): boolean {
	return chat?.observation === null;
}
