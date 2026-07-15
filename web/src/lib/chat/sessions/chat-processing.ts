import type { ChatSessionRecord } from '$lib/types/chat-session';

type ProcessingChat = Pick<ChatSessionRecord, 'status' | 'isProcessing'>;

export function isChatProcessing(chat: ProcessingChat | null | undefined): boolean {
	return chat?.status === 'running' && chat.isProcessing === true;
}
