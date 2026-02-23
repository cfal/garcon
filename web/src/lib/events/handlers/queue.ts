// Handles queue-state-updated and queue-dispatching events.

import type { QueueStateUpdatedMessage, QueueDispatchingMessage } from '$shared/ws-events';
import { UserMessage } from '$shared/chat-types';
import type { ChatMessage, QueueState } from '$lib/types/chat';

export interface QueueContext {
	currentChatId: string | null;
	selectedChatId: string | null;
	setChatMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
	setMessageQueue: (chatId: string, queue: QueueState | null) => void;
	activateLoadingFor: (chatId?: string | null) => void;
	setCanAbort: (v: boolean) => void;
	onChatProcessing?: (chatId?: string | null) => void;
}

function isForCurrentSession(chatId: string, ctx: QueueContext): boolean {
	return chatId === ctx.currentChatId || chatId === ctx.selectedChatId;
}

export function handleQueueUpdated(msg: QueueStateUpdatedMessage, ctx: QueueContext) {
	if (msg.queue) {
		ctx.setMessageQueue(msg.chatId, msg.queue);
	}
}

export function handleQueueSending(msg: QueueDispatchingMessage, ctx: QueueContext) {
	if (isForCurrentSession(msg.chatId, ctx) && msg.content) {
		ctx.setChatMessages((previous) => [
			...previous,
			new UserMessage(new Date().toISOString(), String(msg.content)),
		]);
		ctx.activateLoadingFor(msg.chatId || ctx.currentChatId);
		ctx.setCanAbort(true);
		ctx.onChatProcessing?.(msg.chatId || undefined);
	}
}
