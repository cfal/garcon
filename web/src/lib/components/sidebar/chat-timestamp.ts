import { formatRelativeTimestamp, type RelativeTimestamp } from '$lib/utils/relative-timestamp.js';

export type SidebarChatTimestamp = RelativeTimestamp;

export function formatSidebarChatTimestamp(
	timestamp: string | null,
	currentTime: Date,
): SidebarChatTimestamp | null {
	return formatRelativeTimestamp(timestamp, currentTime);
}
