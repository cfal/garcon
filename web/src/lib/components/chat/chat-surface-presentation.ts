import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types.js';

export type ChatSurfacePresentation = 'conversation' | 'loading' | 'empty';

export function resolveChatSurfacePresentation(
	selectedChat: ChatSessionRecord | null,
	isLoadingChats: boolean,
): ChatSurfacePresentation {
	return selectedChat ? 'conversation' : isLoadingChats ? 'loading' : 'empty';
}
