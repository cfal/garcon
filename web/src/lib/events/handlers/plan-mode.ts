// Handles plan mode transitions from tool-use messages with
// EnterPlanMode / ExitPlanMode tool types.

import type { AgentRunOutputMessage } from '$shared/ws-events';
import { isToolUseMessage } from '$shared/chat-types';
import type { PermissionMode } from '$lib/types/chat';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';

export interface PlanModeContext {
	getCurrentChatId: () => string | null;
	getPermissionMode: () => PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
	conversationUi: Pick<
		ConversationUiStore,
		'setPreviousPermissionMode' | 'setPendingPermissionRequests'
	>;
}

export function handlePlanModeMessages(msg: AgentRunOutputMessage, ctx: PlanModeContext) {
	if (!msg.messages) return;

	for (const chatMsg of msg.messages) {
		if (!isToolUseMessage(chatMsg)) continue;

		if (chatMsg.type === 'enter-plan-mode-tool-use') {
			const permissionMode = ctx.getPermissionMode();
			if (permissionMode !== 'plan') {
				ctx.conversationUi.setPreviousPermissionMode(permissionMode);
			}
			ctx.setPermissionMode('plan');
		}

		if (chatMsg.type === 'exit-plan-mode-tool-use') {
			const permissionRequestId = `plan-exit-${chatMsg.toolId}`;
			ctx.conversationUi.setPendingPermissionRequests((prev) => {
				if (prev.some((r) => r.permissionRequestId === permissionRequestId)) return prev;
				return [
					...prev,
					{
						permissionRequestId,
						requestedTool: chatMsg,
						chatId: msg.chatId || ctx.getCurrentChatId(),
						receivedAt: new Date(),
					},
				];
			});
		}
	}
}
