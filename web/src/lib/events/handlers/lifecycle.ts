// Handles agent-run-finished and agent-run-failed events for all providers.
// Covers chat completion, chat reloading, and error display.

import type { AgentRunFinishedMessage, AgentRunFailedMessage } from '$shared/ws-events';
import type { LocalNoticeType } from '$lib/chat/local-notice';
import type { ConversationUiStore } from '$lib/stores/conversation-ui.svelte';

export interface LifecycleContext {
	getCurrentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	appendLocalNotice: (noticeType: LocalNoticeType, content: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
	conversationUi: Pick<
		ConversationUiStore,
		'setPendingPermissionRequests' | 'clearPendingPermissionRequests'
	>;
	clearTurnStatus: (chatId?: string | null) => void;
	markChatsAsCompleted: (...ids: Array<string | null | undefined>) => void;
	onNavigateToChat?: (chatId: string) => void;
	getPendingChatId: () => string | null;
	clearPendingChatId: () => void;
	markChatSnapshotValidated?: (chatId: string) => void;
}

export function handleAgentComplete(msg: AgentRunFinishedMessage, ctx: LifecycleContext) {
	const pendingChatId = ctx.getPendingChatId();
	const currentChatId = ctx.getCurrentChatId();
	const completedChatId = msg.chatId || currentChatId || pendingChatId;

	ctx.clearTurnStatus(completedChatId);
	ctx.markChatsAsCompleted(completedChatId);

	// Navigate to completed chat if it was pending and didn't error
	if (pendingChatId && !currentChatId && msg.exitCode !== 1) {
		ctx.setCurrentChatId(completedChatId);
		ctx.setIsSystemChatChange(true);
		if (completedChatId) {
			ctx.onNavigateToChat?.(completedChatId);
		}
		ctx.clearPendingChatId();
	}

	if (completedChatId && msg.exitCode !== 1) {
		ctx.markChatSnapshotValidated?.(completedChatId);
	}

	// Preserve plan-exit permission requests across turn boundaries
	ctx.conversationUi.setPendingPermissionRequests((prev) =>
		prev.filter((r) => r.permissionRequestId.startsWith('plan-exit-')),
	);
}

export function handleAgentError(msg: AgentRunFailedMessage, ctx: LifecycleContext) {
	const errorChatId = msg.chatId || ctx.getCurrentChatId();

	ctx.clearTurnStatus(errorChatId);
	ctx.markChatsAsCompleted(errorChatId);

	ctx.appendLocalNotice('error', msg.error || 'An error occurred');
	ctx.conversationUi.clearPendingPermissionRequests();
}
