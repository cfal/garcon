// Handles execution-control snapshots and queue dispatch lifecycle events.

import type {
	ChatExecutionControlUpdatedMessage,
	QueueDispatchingMessage,
} from '$shared/ws-events';
import type { ConversationUiPort } from '$lib/chat/conversation/conversation-ui-state.svelte.js';

export interface QueueContext {
	getCurrentChatId: () => string | null;
	getSelectedChatId: () => string | null;
	conversationUi: Pick<ConversationUiPort, 'setExecutionControl'>;
	markTurnRunning: (chatId?: string | null) => void;
	onChatProcessing: (chatId?: string | null) => void;
}

function isForCurrentSession(chatId: string, ctx: QueueContext): boolean {
	return chatId === ctx.getCurrentChatId() || chatId === ctx.getSelectedChatId();
}

export function handleExecutionControlUpdated(
	msg: ChatExecutionControlUpdatedMessage,
	ctx: QueueContext,
) {
	ctx.conversationUi.setExecutionControl(msg.chatId, msg.control);
}

export function handleQueueSending(msg: QueueDispatchingMessage, ctx: QueueContext) {
	if (isForCurrentSession(msg.chatId, ctx)) {
		ctx.markTurnRunning(msg.chatId || ctx.getCurrentChatId());
		ctx.onChatProcessing(msg.chatId || undefined);
	}
}
