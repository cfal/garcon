// Handles permission lifecycle from chat event message batches.
// Inspects ChatMessage entries for permission-request, permission-resolved,
// permission-cancelled, and permission-expired types.

import {
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
	PermissionExpiredMessage,
	type ChatMessage,
} from '$shared/chat-types';
import type { LoadingStatusEntry } from '$lib/chat/conversation/conversation-lifecycle-state.svelte.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

export interface PermissionLifecycleContext {
	getCurrentChatId: () => string | null;
	conversationUi: Pick<ConversationUiPort, 'setPendingPermissionRequests'>;
	markTurnRunning: (chatId?: string | null) => void;
	pushLoadingStatus: (entry: LoadingStatusEntry) => void;
	popLoadingStatus: (id: string) => void;
}

const WAITING_FOR_PERMISSION_ID = 'WAITING_FOR_PERMISSION';

// Scans a message batch for permission lifecycle messages and updates
// pending permission state and loading status accordingly.
export function handlePermissionLifecycleFromBatch(
	msg: { chatId?: string | null; messages: ChatMessage[] },
	ctx: PermissionLifecycleContext,
) {
	if (!msg.messages) return;

	for (const entry of msg.messages) {
		if (entry instanceof PermissionRequestMessage) {
			let requestAdded = false;
			ctx.conversationUi.setPendingPermissionRequests((previous) => {
				if (previous.some((request) => (
					request.permissionOccurrenceId === entry.permissionOccurrenceId
				)))
					return previous;
				requestAdded = true;
				return [
					...previous,
					{
						permissionOccurrenceId: entry.permissionOccurrenceId,
						requestedTool: entry.requestedTool,
						chatId: msg.chatId || null,
						receivedAt: new Date(),
					},
				];
			});

			if (requestAdded) {
				ctx.markTurnRunning(msg.chatId || ctx.getCurrentChatId());
				ctx.pushLoadingStatus({
					id: WAITING_FOR_PERMISSION_ID,
					text: m.chat_loading_waiting_for_permission(),
					tokens: 0,
					can_interrupt: true,
				});
			}
		}

		if (
			entry instanceof PermissionResolvedMessage
			|| entry instanceof PermissionCancelledMessage
			|| entry instanceof PermissionExpiredMessage
		) {
			let occurrenceRemoved = false;
			ctx.conversationUi.setPendingPermissionRequests((previous) => {
				const remaining = previous.filter((request) => (
					request.permissionOccurrenceId !== entry.permissionOccurrenceId
				));
				occurrenceRemoved = remaining.length !== previous.length;
				return occurrenceRemoved ? remaining : previous;
			});
			if (occurrenceRemoved) ctx.popLoadingStatus(WAITING_FOR_PERMISSION_ID);
		}
	}
}
