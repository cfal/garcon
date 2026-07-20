// Handles agent-run-finished and agent-run-failed events for all providers.
// Covers chat completion, chat reloading, and error display.

import type { AgentRunFinishedMessage, AgentRunFailedMessage } from '$shared/ws-events';
import type { LocalNoticeType } from '$lib/chat/transcript/local-notice.js';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';
import * as m from '$lib/paraglide/messages.js';

const AGENT_REPORTED_FAILURE_EXIT_CODE = 1;

function agentReportedFailure(exitCode: number | undefined): boolean {
	return exitCode === AGENT_REPORTED_FAILURE_EXIT_CODE;
}

export interface LifecycleContext {
	getCurrentChatId: () => string | null;
	setCurrentChatId: (id: string | null) => void;
	appendLocalNotice: (noticeType: LocalNoticeType, content: string) => void;
	setIsSystemChatChange: (v: boolean) => void;
	conversationUi: Pick<
		ConversationUiPort,
		'setPendingPermissionRequests' | 'clearPendingPermissionRequests'
	>;
	clearTurnStatus: (chatId?: string | null) => void;
	isChatProcessing: (chatId?: string | null) => boolean;
	onNavigateToChat: (chatId: string) => void;
	getPendingChatId: () => string | null;
	clearPendingChatId: () => void;
	markChatTranscriptValidated: (chatId: string) => void;
}

export function handleAgentComplete(msg: AgentRunFinishedMessage, ctx: LifecycleContext) {
	const pendingChatId = ctx.getPendingChatId();
	const currentChatId = ctx.getCurrentChatId();
	const completedChatId = msg.chatId || currentChatId || pendingChatId;
	const successorIsProcessing = ctx.isChatProcessing(completedChatId);

	if (!successorIsProcessing) ctx.clearTurnStatus(completedChatId);

	const runFailed = agentReportedFailure(msg.exitCode);

	// Navigate to completed chat if it was pending and didn't error.
	if (pendingChatId && !currentChatId && !runFailed) {
		ctx.setCurrentChatId(completedChatId);
		ctx.setIsSystemChatChange(true);
		if (completedChatId) {
			ctx.onNavigateToChat(completedChatId);
		}
		ctx.clearPendingChatId();
	}

	if (completedChatId && !runFailed) {
		ctx.markChatTranscriptValidated(completedChatId);
	}

	// Preserve plan-exit permission requests across turn boundaries
	if (!successorIsProcessing) {
		ctx.conversationUi.setPendingPermissionRequests((prev) =>
			prev.filter((r) => r.permissionRequestId.startsWith('plan-exit-')),
		);
	}
}

export function handleAgentError(msg: AgentRunFailedMessage, ctx: LifecycleContext) {
	const errorChatId = msg.chatId || ctx.getCurrentChatId();
	const successorIsProcessing = ctx.isChatProcessing(errorChatId);

	if (!successorIsProcessing) ctx.clearTurnStatus(errorChatId);

	ctx.appendLocalNotice('error', msg.error || m.chat_notice_agent_error());
	if (!successorIsProcessing) ctx.conversationUi.clearPendingPermissionRequests();
}
