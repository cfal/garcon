// Determines whether a WebSocket message should be processed by the current
// view, based on chat identity. Global events (sidebar, status) always pass;
// scoped events pass only when they match the active chat.

import type { ServerWsMessage, EventKey } from '$shared/ws-events';

export interface ChatFilterContext {
	selectedChatId: string | null;
	currentChatId: string | null;
	pendingViewChatId: string | null;
}

export type ChatFilterResult =
	| { action: 'process' }
	| { action: 'skip' };

const GLOBAL_MESSAGE_TYPES = new Set<EventKey>([
	'chat-sessions-running',
	'chat-session-created',
	'chat-session-deleted',
	'chat-processing-updated',
	'queue-state-updated',
	'chat-title-updated',
	'chat-read-updated-v1',
	'chat-list-refresh-requested',
] satisfies EventKey[]);

// Extracts chatId from any message in the union. Most message types
// carry chatId; returns empty string for those that don't.
function getChatId(message: ServerWsMessage): string {
	if (!('chatId' in message)) return '';
	if (typeof message.chatId !== 'string') return '';
	return message.chatId;
}

export function filterByChat(
	key: EventKey,
	message: ServerWsMessage,
	ctx: ChatFilterContext,
): ChatFilterResult {
	if (GLOBAL_MESSAGE_TYPES.has(key)) {
		return { action: 'process' };
	}

	const activeViewChatId =
		ctx.selectedChatId || ctx.currentChatId || ctx.pendingViewChatId;

	const messageChatId = getChatId(message);

	if (!activeViewChatId || !messageChatId) {
		return { action: 'skip' };
	}

	if (messageChatId !== activeViewChatId) {
		return { action: 'skip' };
	}

	return { action: 'process' };
}
