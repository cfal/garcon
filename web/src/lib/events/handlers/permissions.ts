// Handles permission lifecycle from agent-run-output message batches.
// Inspects ChatMessage entries for permission-request, permission-resolved,
// and permission-cancelled types.

import type { AgentRunOutputMessage } from '$shared/ws-events';
import { PermissionRequestMessage, PermissionResolvedMessage, PermissionCancelledMessage } from '$shared/chat-types';
import type { PendingPermissionRequest } from '$lib/types/chat';
import type { LoadingStatusEntry } from '$lib/stores/chat-lifecycle.svelte';
import * as m from '$lib/paraglide/messages.js';

export interface PermissionLifecycleContext {
	currentChatId: string | null;
	setPendingPermissionRequests: (
		updater: (prev: PendingPermissionRequest[]) => PendingPermissionRequest[],
	) => void;
	activateLoadingFor: (chatId?: string | null) => void;
	setCanAbort: (v: boolean) => void;
	pushLoadingStatus: (entry: LoadingStatusEntry) => void;
	popLoadingStatus: (id: string) => void;
}

const WAITING_FOR_PERMISSION_ID = 'WAITING_FOR_PERMISSION';

// Scans a message batch for permission lifecycle messages and updates
// pending permission state and loading status accordingly.
export function handlePermissionLifecycleFromBatch(
	msg: AgentRunOutputMessage,
	ctx: PermissionLifecycleContext,
) {
	if (!msg.messages) return;

	for (const entry of msg.messages) {
		if (entry instanceof PermissionRequestMessage) {
			ctx.setPendingPermissionRequests((previous) => {
				if (previous.some((r) => r.permissionRequestId === entry.permissionRequestId)) return previous;
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

			ctx.activateLoadingFor(msg.chatId || ctx.currentChatId);
			ctx.setCanAbort(true);
			ctx.pushLoadingStatus({
				id: WAITING_FOR_PERMISSION_ID,
				text: m.chat_loading_waiting_for_permission(),
				tokens: 0,
				can_interrupt: true,
			});
		}

		if (entry instanceof PermissionResolvedMessage) {
			ctx.popLoadingStatus(WAITING_FOR_PERMISSION_ID);
			ctx.setPendingPermissionRequests((previous) =>
				previous.filter((r) => r.permissionRequestId !== entry.permissionRequestId),
			);
		}

		if (entry instanceof PermissionCancelledMessage) {
			ctx.popLoadingStatus(WAITING_FOR_PERMISSION_ID);
			ctx.setPendingPermissionRequests((previous) =>
				previous.filter((r) => r.permissionRequestId !== entry.permissionRequestId),
			);
		}
	}
}
