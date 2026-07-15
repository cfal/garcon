// Handles queue-state-updated and queue-dispatching events.

import type { QueueStateUpdatedMessage, QueueDispatchingMessage } from '$shared/ws-events';
import type { ConversationUiState } from '$lib/chat/conversation/conversation-ui-state.svelte.js';

export interface QueueContext {
	getCurrentChatId: () => string | null;
	getSelectedChatId: () => string | null;
	conversationUi: Pick<ConversationUiState, 'setMessageQueue'>;
	markTurnRunning: (chatId?: string | null) => void;
	onChatProcessing: (chatId?: string | null) => void;
}

function isForCurrentSession(chatId: string, ctx: QueueContext): boolean {
	return chatId === ctx.getCurrentChatId() || chatId === ctx.getSelectedChatId();
}

export function handleQueueUpdated(msg: QueueStateUpdatedMessage, ctx: QueueContext) {
	if (msg.queue) {
		ctx.conversationUi.setMessageQueue(msg.chatId, msg.queue);
	}
}

export function handleQueueSending(msg: QueueDispatchingMessage, ctx: QueueContext) {
	if (isForCurrentSession(msg.chatId, ctx)) {
		ctx.markTurnRunning(msg.chatId || ctx.getCurrentChatId());
		ctx.onChatProcessing(msg.chatId || undefined);
	}
}
