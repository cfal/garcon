// Handles plan mode transitions from tool-use messages with
// EnterPlanMode / ExitPlanMode tool types.

import { isToolUseMessage } from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { PermissionMode } from '$lib/types/chat';
import type { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';

export interface PlanModeContext {
	getCurrentChatId: () => string | null;
	getPermissionMode: () => PermissionMode;
	setPermissionMode: (mode: PermissionMode) => void;
	conversationUi: Pick<
		ConversationUiState,
		'setPreviousPermissionMode' | 'setPendingPermissionRequests'
	>;
}

export function handlePlanModeMessages(
	msg: { chatId?: string | null; messages: ChatMessage[] },
	ctx: PlanModeContext,
) {
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
