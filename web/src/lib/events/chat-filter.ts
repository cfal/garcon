// Determines whether a WebSocket message should be processed by the current
// view, based on chat identity. Global events (sidebar, status) always pass;
// scoped events pass only when they match the active chat.

import type { ServerWsMessage, EventKey } from '$shared/ws-events';

export interface ChatFilterContext {
	selectedChatId: string | null;
	currentChatId: string | null;
	pendingViewChatId: string | null;
}

export type ChatFilterResult = { action: 'process' } | { action: 'skip' };

const GLOBAL_MESSAGE_TYPES = new Set<EventKey>([
	'chat-session-created',
	'chat-session-deleted',
	'chat-processing-updated',
	'chat-generation-reset',
	'chat-execution-control-updated',
	'chat-title-updated',
	'chat-project-path-updated',
	'chat-read-updated-v1',
	'chat-list-refresh-requested',
	'ws-fault',
] satisfies EventKey[]);

// Extracts chatId from any message in the union. Most message types
// carry chatId; returns empty string for those that don't.
function getChatId(message: ServerWsMessage): string {
	if ('chatId' in message) {
		return typeof message.chatId === 'string' ? message.chatId : '';
	}
	if (message.type === 'pending-user-input-updated') {
		return message.input.chatId;
	}
	return '';
}

export function filterByChat(
	key: EventKey,
	message: ServerWsMessage,
	ctx: ChatFilterContext,
): ChatFilterResult {
	if (GLOBAL_MESSAGE_TYPES.has(key)) {
		return { action: 'process' };
	}

	const activeViewChatId = ctx.selectedChatId || ctx.currentChatId || ctx.pendingViewChatId;

	const messageChatId = getChatId(message);

	if (!activeViewChatId || !messageChatId) {
		return { action: 'skip' };
	}

	if (messageChatId !== activeViewChatId) {
		return { action: 'skip' };
	}

	return { action: 'process' };
}
