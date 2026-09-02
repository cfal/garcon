import { chatActivityTimeMs } from './chat-recency-sort';
import type { SidebarInactivityDuration } from '$lib/stores/local-settings.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const DAY_MS = 24 * 60 * 60 * 1000;

// Month options are fixed elapsed durations so classification does not vary by
// calendar position or local timezone.
export const SIDEBAR_INACTIVITY_DURATION_MS: Record<SidebarInactivityDuration, number> = {
	'2-days': 2 * DAY_MS,
	'3-days': 3 * DAY_MS,
	'4-days': 4 * DAY_MS,
	'5-days': 5 * DAY_MS,
	'1-week': 7 * DAY_MS,
	'2-weeks': 14 * DAY_MS,
	'1-month': 30 * DAY_MS,
	'2-months': 60 * DAY_MS,
	'3-months': 90 * DAY_MS,
};

/**
 * Reports whether a chat's last activity (or creation, when it never had
 * activity) is at least the configured duration before `now`. Chats without
 * parsable timestamps count as inactive.
 */
export function isSidebarChatInactive(
	chat: Pick<ChatSessionRecord, 'lastActivityAt' | 'createdAt'>,
	now: Date,
	duration: SidebarInactivityDuration,
): boolean {
	return now.getTime() - chatActivityTimeMs(chat) >= SIDEBAR_INACTIVITY_DURATION_MS[duration];
}
