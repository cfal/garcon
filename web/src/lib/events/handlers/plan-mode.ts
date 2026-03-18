// Handles plan mode transitions from tool-use messages with
// EnterPlanMode / ExitPlanMode tool types.

import type { AgentRunOutputMessage } from '$shared/ws-events';
import { isToolUseMessage } from '$shared/chat-types';
import type { PendingPermissionRequest, PermissionMode } from '$lib/types/chat';

export interface PlanModeContext {
	currentChatId: string | null;
	permissionMode: PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
	setPreviousPermissionMode: (mode: PermissionMode | null) => void;
	setPendingPermissionRequests: (
		updater: (prev: PendingPermissionRequest[]) => PendingPermissionRequest[],
	) => void;
}

export function handlePlanModeMessages(msg: AgentRunOutputMessage, ctx: PlanModeContext) {
	if (!msg.messages) return;

	for (const chatMsg of msg.messages) {
		if (!isToolUseMessage(chatMsg)) continue;

		if (chatMsg.type === 'enter-plan-mode-tool-use') {
			if (ctx.permissionMode !== 'plan') {
				ctx.setPreviousPermissionMode(ctx.permissionMode);
			}
			ctx.setPermissionMode('plan');
		}

		if (chatMsg.type === 'exit-plan-mode-tool-use') {
			const permissionRequestId = `plan-exit-${chatMsg.toolId}`;
			ctx.setPendingPermissionRequests((prev) => {
				if (prev.some((r) => r.permissionRequestId === permissionRequestId)) return prev;
				return [
					...prev,
					{
						permissionRequestId,
						requestedTool: chatMsg,
						chatId: msg.chatId || ctx.currentChatId,
						receivedAt: new Date(),
					},
				];
			});
		}
	}
}
