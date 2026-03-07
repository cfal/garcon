// Handles agent-run-finished and agent-run-failed events for all providers.
// Covers chat completion, chat reloading, and error display.

import type { AgentRunFinishedMessage, AgentRunFailedMessage } from '$shared/ws-events';
import { ErrorMessage } from '$shared/chat-types';
import type { ChatMessage, PendingPermissionRequest } from '$lib/types/chat';

export interface LifecycleContext {
	currentChatId: string | null;
	setCurrentChatId: (id: string | null) => void;
	setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
	setIsSystemChatChange: (v: boolean) => void;
	setPendingPermissionRequests: (
		updater:
			| PendingPermissionRequest[]
			| ((prev: PendingPermissionRequest[]) => PendingPermissionRequest[]),
	) => void;
	clearLoadingIndicators: (chatId?: string | null) => void;
	markChatsAsCompleted: (...ids: Array<string | null | undefined>) => void;
	onNavigateToChat?: (chatId: string) => void;
	getPendingChatId: () => string | null;
	clearPendingChatId: () => void;
	markChatSnapshotValidated?: (chatId: string) => void;
}

export function handleAgentComplete(msg: AgentRunFinishedMessage, ctx: LifecycleContext) {
	const pendingChatId = ctx.getPendingChatId();
	const completedChatId = msg.chatId || ctx.currentChatId || pendingChatId;

	ctx.clearLoadingIndicators(completedChatId);
	ctx.markChatsAsCompleted(completedChatId);

	// Navigate to completed chat if it was pending and didn't error
	if (pendingChatId && !ctx.currentChatId && msg.exitCode !== 1) {
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
	ctx.setPendingPermissionRequests((prev) =>
		prev.filter((r) => r.permissionRequestId.startsWith('plan-exit-')),
	);
}

export function handleAgentError(msg: AgentRunFailedMessage, ctx: LifecycleContext) {
	const errorChatId = msg.chatId || ctx.currentChatId;

	ctx.clearLoadingIndicators(errorChatId);
	ctx.markChatsAsCompleted(errorChatId);

	ctx.setChatMessages((prev) => [
		...prev,
		new ErrorMessage(new Date().toISOString(), msg.error || 'An error occurred'),
	]);
	ctx.setPendingPermissionRequests([]);
}
