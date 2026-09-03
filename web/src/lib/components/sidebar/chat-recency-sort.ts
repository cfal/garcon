// Shared recency ordering for sidebar chat lists. Ranks chats by the newest of
// their activity and creation timestamps so clock skew or null projections
// cannot order a chat below its own creation.

import { CHAT_ID_LENGTH, chatIdCreatedAt } from '$shared/chat-id';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const CANONICAL_CHAT_ID_PATTERN = new RegExp(`^\\d{${CHAT_ID_LENGTH}}$`);

function validTimeMs(value: string | null): number | null {
	if (!value) return null;
	const time = new Date(value).getTime();
	return Number.isFinite(time) ? time : null;
}

function chatIdTimeMs(chatId: string): number | null {
	if (!CANONICAL_CHAT_ID_PATTERN.test(chatId)) return null;
	try {
		const time = chatIdCreatedAt(chatId).getTime();
		return Number.isFinite(time) ? time : null;
	} catch {
		// Sixteen digits establish shape, not validity; a bad id must not break sorting.
		return null;
	}
}

/**
 * Canonical activity timestamp for sidebar chat ordering: the newest of last
 * activity, creation time, and the creation time embedded in the chat id. The
 * id carries the browser clock from draft creation, so server clock steps or
 * null projected timestamps can never order a chat below its own creation.
 */
export function chatActivityTimeMs(
	chat: Pick<ChatSessionRecord, 'id' | 'lastActivityAt' | 'createdAt'>,
): number {
	return Math.max(
		validTimeMs(chat.lastActivityAt) ?? 0,
		validTimeMs(chat.createdAt) ?? 0,
		chatIdTimeMs(chat.id) ?? 0,
	);
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
