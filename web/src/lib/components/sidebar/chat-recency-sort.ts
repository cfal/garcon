// Shared recency ordering for sidebar chat lists. Ranks chats by most recent
// activity, falling back to creation time so chats without activity still order
// deterministically.

import type { ChatSessionRecord } from '$lib/types/chat-session';

/**
 * Canonical activity timestamp for sidebar chat ordering: last activity with
 * creation-time fallback, so chats without activity still order deterministically.
 */
export function chatActivityTimeMs(
	chat: Pick<ChatSessionRecord, 'lastActivityAt' | 'createdAt'>,
): number {
	if (chat.lastActivityAt) {
		const time = new Date(chat.lastActivityAt).getTime();
		if (Number.isFinite(time)) return time;
	}
	if (chat.createdAt) {
		const time = new Date(chat.createdAt).getTime();
		if (Number.isFinite(time)) return time;
	}
	return 0;
}

/** Comparator ordering chats newest-first by activity, then creation time. */
export function compareChatsByRecencyDesc(a: ChatSessionRecord, b: ChatSessionRecord): number {
	const aIsDraft = a.status === 'draft';
	const bIsDraft = b.status === 'draft';
	// Local drafts have no server timestamps but represent the newest user activity.
	if (aIsDraft !== bIsDraft) return aIsDraft ? -1 : 1;
	return chatActivityTimeMs(b) - chatActivityTimeMs(a);
}

/** Returns a new array of chats ordered newest-first. */
export function sortChatsByRecencyDesc(chats: ChatSessionRecord[]): ChatSessionRecord[] {
	return [...chats].sort(compareChatsByRecencyDesc);
}
