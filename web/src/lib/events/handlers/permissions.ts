// Handles permission lifecycle from chat event message batches.
// Inspects ChatMessage entries for permission-request, permission-resolved,
// and permission-cancelled types.

import {
	PermissionRequestMessage,
	PermissionResolvedMessage,
	PermissionCancelledMessage,
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
				if (previous.some((r) => r.permissionRequestId === entry.permissionRequestId))
					return previous;
				requestAdded = true;
				return [
					...previous,
					{
						permissionRequestId: entry.permissionRequestId,
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

		if (entry instanceof PermissionResolvedMessage) {
			ctx.popLoadingStatus(WAITING_FOR_PERMISSION_ID);
			ctx.conversationUi.setPendingPermissionRequests((previous) =>
				previous.filter((r) => r.permissionRequestId !== entry.permissionRequestId),
			);
		}

		if (entry instanceof PermissionCancelledMessage) {
			ctx.popLoadingStatus(WAITING_FOR_PERMISSION_ID);
			ctx.conversationUi.setPendingPermissionRequests((previous) =>
				previous.filter((r) => r.permissionRequestId !== entry.permissionRequestId),
			);
		}
	}
}
