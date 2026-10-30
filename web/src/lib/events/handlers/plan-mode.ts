// Applies plan-mode transitions reported by a committed span's activity. The
// activity reaches every socket, so an undisplayed chat still enters plan mode
// and keeps its plan approval actionable for when it is displayed again.

import type { ChatTranscriptActivity } from '$shared/chat-transcript-activity';
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

export function handlePlanModeActivity(
	chatId: string,
	activity: Pick<ChatTranscriptActivity, 'planModeEntered' | 'planExitRequests'>,
	ctx: PlanModeContext,
) {
	if (!chatId) return;

	if (activity.planModeEntered) {
		const permissionMode = ctx.getPermissionMode(chatId);
		if (permissionMode && permissionMode !== 'plan') {
			ctx.conversationUi.beginPlanModeForChat(chatId, permissionMode);
		}
		ctx.setPermissionMode(chatId, 'plan');
	}

	for (const request of activity.planExitRequests) {
		const permissionOccurrenceId = `plan-exit-${request.toolId}`;
		ctx.conversationUi.updatePendingPermissionsForChat(chatId, (prev) => {
			if (prev.some((pending) => pending.permissionOccurrenceId === permissionOccurrenceId))
				return prev;
			return [
				...prev,
				{
					permissionOccurrenceId,
					requestedTool: request,
					chatId,
					receivedAt: new Date(),
				},
			];
		});
	}
}
