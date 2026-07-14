import type { ChatSessionRecord } from '$lib/types/chat-session.js';

export type ChatSurfacePresentation = 'conversation' | 'loading' | 'empty';

export function resolveChatSurfacePresentation(
	selectedChat: Pick<
		ChatSessionRecord,
		'status' | 'projectIdentityState' | 'effectiveProjectKey'
	> | null,
	isLoadingChats: boolean,
): ChatSurfacePresentation {
	if (!selectedChat) return isLoadingChats ? 'loading' : 'empty';
	if (selectedChat.status === 'draft') return 'conversation';
	return selectedChat.projectIdentityState === 'available' && selectedChat.effectiveProjectKey
		? 'conversation'
		: 'loading';
}
