// Handles plan mode transitions from tool-use messages with
// EnterPlanMode / ExitPlanMode tool types.

import { isToolUseMessage } from '$shared/chat-types';
import type { ChatMessage } from '$shared/chat-types';
import type { PermissionMode } from '$lib/types/chat';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';

export interface PlanModeContext {
	getPermissionMode: (chatId: string) => PermissionMode | null;
	setPermissionMode: (chatId: string, mode: PermissionMode) => void;
	conversationUi: Pick<
		ConversationUiPort,
		'beginPlanModeForChat' | 'updatePendingPermissionsForChat'
	>;
}

export function handlePlanModeMessages(
	msg: { chatId?: string | null; messages: ChatMessage[] },
	ctx: PlanModeContext,
) {
	const chatId = msg.chatId ?? null;
	if (!chatId || !msg.messages) return;

	for (const chatMsg of msg.messages) {
		if (!isToolUseMessage(chatMsg)) continue;

		if (chatMsg.type === 'enter-plan-mode-tool-use') {
			const permissionMode = ctx.getPermissionMode(chatId);
			if (permissionMode && permissionMode !== 'plan') {
				ctx.conversationUi.beginPlanModeForChat(chatId, permissionMode);
			}
			ctx.setPermissionMode(chatId, 'plan');
		}

		if (chatMsg.type === 'exit-plan-mode-tool-use') {
			const permissionOccurrenceId = `plan-exit-${chatMsg.toolId}`;
			ctx.conversationUi.updatePendingPermissionsForChat(chatId, (prev) => {
				if (prev.some((request) => (
					request.permissionOccurrenceId === permissionOccurrenceId
				))) return prev;
				return [
					...prev,
					{
						permissionOccurrenceId,
						requestedTool: chatMsg,
						chatId,
						receivedAt: new Date(),
					},
				];
			});
		}
	}
}
