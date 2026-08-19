// Handles agent-run-finished and agent-run-failed events for all providers.
// Covers chat completion, chat reloading, and error display.

import type { AgentRunFinishedMessage, AgentRunFailedMessage } from '$shared/ws-events';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

function agentRunSucceeded(exitCode: number | undefined): boolean {
	return exitCode === 0;
}

export interface LifecycleContext {
	getCurrentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	appendServerNotice: (chatId: string, noticeType: LocalNoticeType, content: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
	conversationUi: Pick<
		ConversationUiPort,
		'clearPendingPermissionRequests' | 'clearTurnPermissionRequests'
	>;
	clearTurnStatus: (chatId?: string | null) => void;
	isChatProcessing: (chatId?: string | null) => boolean;
	onNavigateToChat: (chatId: string) => void;
	getPendingChatId: () => string | null;
	clearPendingChatId: () => void;
	markChatTranscriptValidated: (chatId: string) => void;
	notifyCompletion: () => void;
}

export function handleAgentComplete(msg: AgentRunFinishedMessage, ctx: LifecycleContext) {
	const pendingChatId = ctx.getPendingChatId();
	const currentChatId = ctx.getCurrentChatId();
	const completedChatId = msg.chatId || currentChatId || pendingChatId;
	const successorIsProcessing = ctx.isChatProcessing(completedChatId);

	if (!successorIsProcessing) ctx.clearTurnStatus(completedChatId);

	const runSucceeded = agentRunSucceeded(msg.exitCode);

	// Navigate to completed chat if it was pending and didn't error.
	if (pendingChatId && !currentChatId && runSucceeded) {
		ctx.setCurrentChatId(completedChatId);
		ctx.setIsSystemChatChange(true);
		if (completedChatId) {
			ctx.onNavigateToChat(completedChatId);
		}
		ctx.clearPendingChatId();
	}

	if (completedChatId && runSucceeded) {
		ctx.markChatTranscriptValidated(completedChatId);
	}

	if (runSucceeded && !successorIsProcessing) ctx.notifyCompletion();

	// Preserve plan-exit permission requests across turn boundaries
	if (!successorIsProcessing) {
		ctx.conversationUi.clearTurnPermissionRequests();
	}
}

export function handleAgentError(msg: AgentRunFailedMessage, ctx: LifecycleContext) {
	const errorChatId = msg.chatId || ctx.getCurrentChatId();
	const successorIsProcessing = ctx.isChatProcessing(errorChatId);

	if (!successorIsProcessing) ctx.clearTurnStatus(errorChatId);

	ctx.appendServerNotice(msg.chatId, 'error', msg.error || m.chat_notice_agent_error());
	if (!successorIsProcessing) ctx.conversationUi.clearPendingPermissionRequests();
}
