// Inactivity classification for the project-and-time sidebar grouping mode.

import { chatActivityTimeMs } from './chat-recency-sort';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export const SIDEBAR_INACTIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Reports whether a chat's last activity (or creation, when it never had
 * activity) is at least three days before `now`. Chats without parsable
 * timestamps count as inactive.
 */
export function isSidebarChatInactive(
	chat: Pick<ChatSessionRecord, 'lastActivityAt' | 'createdAt'>,
	now: Date,
): boolean {
	return now.getTime() - chatActivityTimeMs(chat) >= SIDEBAR_INACTIVE_AFTER_MS;
}
