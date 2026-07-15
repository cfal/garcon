import type { ChatSessionsStore } from '$lib/chat/sessions/chat-sessions.svelte.js';
import type { SplitLayoutStore } from '$lib/chat/split/split-layout.svelte.js';
import type { ChatSessionRecord } from '$lib/types/chat-session.js';

export function toggleChatSplitMode(
	splitLayout: SplitLayoutStore,
	sessions: ChatSessionsStore,
	selectedChat: ChatSessionRecord | null,
): void {
	if (splitLayout.isEnabled) {
		const focusedChat = splitLayout.focusedChatId;
		splitLayout.disable();
		if (focusedChat) sessions.setSelectedChatId(focusedChat);
		return;
	}
	if (!selectedChat) return;
	splitLayout.enableWithChat(selectedChat.id);
	const companionChat = sessions.orderedChats.find((chat) => chat.id !== selectedChat.id);
	const initialPane = splitLayout.panes[0];
	if (!companionChat || !initialPane) return;
	splitLayout.splitPane(initialPane.id, 'horizontal', companionChat.id);
	splitLayout.focusPane(initialPane.id);
}
