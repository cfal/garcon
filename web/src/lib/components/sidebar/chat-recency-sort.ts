// Shared recency ordering for sidebar chat lists. Ranks chats by the newest of
// their activity and creation timestamps so clock skew or null projections
// cannot order a chat below its own creation.

import { chatActivityTimeMs } from '$shared/chat-order-sort';
import type { PinnedInsertPosition } from '$shared/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';

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

/** Applies pin-placement policy without changing the order of unpinned chats. */
export function sortSidebarChatsByRecency(
	chats: ChatSessionRecord[],
	pinnedInsertPosition: PinnedInsertPosition,
): ChatSessionRecord[] {
	const newestFirst = sortChatsByRecencyDesc(chats);
	if (pinnedInsertPosition === 'top') return newestFirst;

	const pinnedOldestFirst = chats
		.filter((chat) => chat.isPinned)
		.sort((left, right) => compareChatsByRecencyDesc(right, left));
	let pinnedIndex = 0;
	return newestFirst.map((chat) =>
		chat.isPinned ? (pinnedOldestFirst[pinnedIndex++] ?? chat) : chat,
	);
}
