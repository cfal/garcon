// Shared recency ordering for sidebar chat lists. Ranks chats by most recent
// activity, falling back to creation time so chats without activity still order
// deterministically.

import type { ChatSessionRecord } from '$lib/types/chat-session';

function recencyValue(chat: ChatSessionRecord): number {
	if (chat.lastActivityAt) return new Date(chat.lastActivityAt).getTime();
	if (chat.createdAt) return new Date(chat.createdAt).getTime();
	return 0;
}

/** Comparator ordering chats newest-first by activity, then creation time. */
export function compareChatsByRecencyDesc(a: ChatSessionRecord, b: ChatSessionRecord): number {
	return recencyValue(b) - recencyValue(a);
}

/** Returns a new array of chats ordered newest-first. */
export function sortChatsByRecencyDesc(chats: ChatSessionRecord[]): ChatSessionRecord[] {
	return [...chats].sort(compareChatsByRecencyDesc);
}
