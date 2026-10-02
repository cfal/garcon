import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

type ProcessingChat = Pick<ChatSessionRecord, 'status' | 'isProcessing'>;

export function isChatProcessing(chat: ProcessingChat | null | undefined): boolean {
	return chat?.status === 'running' && chat.isProcessing === true;
}
