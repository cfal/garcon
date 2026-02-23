// Handles plan mode transitions from tool-use messages with
// EnterPlanMode / ExitPlanMode tool names.

import type { AgentRunOutputMessage } from '$shared/ws-events';
import { ToolUseMessage, EnterPlanModeToolUseMessage, ExitPlanModeToolUseMessage } from '$shared/chat-types';
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
		if (!(chatMsg instanceof ToolUseMessage)) continue;

		if (chatMsg instanceof EnterPlanModeToolUseMessage) {
			if (ctx.permissionMode !== 'plan') {
				ctx.setPreviousPermissionMode(ctx.permissionMode);
			}
			ctx.setPermissionMode('plan' as PermissionMode);
		}

		if (chatMsg instanceof ExitPlanModeToolUseMessage) {
			const permissionRequestId = `plan-exit-${chatMsg.toolId}`;
			ctx.setPendingPermissionRequests((prev) => {
				if (prev.some((r) => r.permissionRequestId === permissionRequestId)) return prev;
				return [
					...prev,
					{
						permissionRequestId,
						toolName: 'ExitPlanMode',
						toolInput: { plan: chatMsg.plan, allowedPrompts: chatMsg.allowedPrompts },
						chatId: msg.chatId || ctx.currentChatId,
						receivedAt: new Date(),
					},
				];
			});
		}
	}
}
