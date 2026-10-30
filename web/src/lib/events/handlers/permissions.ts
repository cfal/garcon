// Derives the waiting-for-permission status from actionable permission rows in
// the transient feed. The feed reaches every socket for every chat, unlike
// transcript bodies, so an undisplayed chat shows the status once displayed.

import type { ChatTransientFeedSnapshot } from '$shared/chat-transient-feed';
import type { LoadingStatusEntry } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export interface PermissionLifecycleContext {
	markTurnRunning: (chatId: string) => void;
	pushLoadingStatus: (chatId: string, entry: LoadingStatusEntry) => void;
	popLoadingStatus: (chatId: string, id: string) => void;
}

const WAITING_FOR_PERMISSION_ID = 'WAITING_FOR_PERMISSION';

export function transientPermissionOccurrences(
	feed: Pick<ChatTransientFeedSnapshot, 'rows'> | null,
): ReadonlySet<string> {
	return new Set(feed?.rows.map((row) => row.permissionOccurrenceId) ?? []);
}

// Pushes one status entry per newly actionable occurrence and pops one per
// occurrence that left the feed.
export function handlePermissionFeedTransition(
	chatId: string,
	previous: ReadonlySet<string>,
	next: ReadonlySet<string>,
	ctx: PermissionLifecycleContext,
) {
	for (const occurrence of next) {
		if (previous.has(occurrence)) continue;
		ctx.markTurnRunning(chatId);
		ctx.pushLoadingStatus(chatId, {
			id: WAITING_FOR_PERMISSION_ID,
			text: m.chat_loading_waiting_for_permission(),
			tokens: 0,
			can_interrupt: true,
		});
	}
	for (const occurrence of previous) {
		if (!next.has(occurrence)) ctx.popLoadingStatus(chatId, WAITING_FOR_PERMISSION_ID);
	}
}
