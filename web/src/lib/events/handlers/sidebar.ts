// Handles sidebar-related WebSocket events: chat-title-updated, chat-session-deleted,
// chat-read-updated-v1, and chat-list-refresh-requested. These events drive
// sidebar state so the UI stays in sync with server-side mutations
// without polling.

import type { ChatTitleUpdatedMessage, ChatSessionDeletedWsMessage, ChatReadUpdatedV1Message, ChatListRefreshRequestedMessage } from '$shared/ws-events';

export interface SidebarContext {
	removeChat: (chatId: string) => void;
	navigateAwayFromChat: (chatId: string) => void;
	patchChatTitle: (chatId: string, title: string) => void;
	patchLastReadAt: (chatId: string, lastReadAt: string) => void;
	refreshChats: () => void;
}

export function handleChatTitle(
	msg: ChatTitleUpdatedMessage,
	ctx: SidebarContext,
) {
	if (!msg.chatId || !msg.title) return;
	ctx.patchChatTitle(msg.chatId, msg.title);
}

export function handleChatDeleted(
	msg: ChatSessionDeletedWsMessage,
	ctx: SidebarContext,
) {
	if (!msg.chatId) return;
	ctx.navigateAwayFromChat(msg.chatId);
	ctx.removeChat(msg.chatId);
}

export function handleChatReadUpdated(
	msg: ChatReadUpdatedV1Message,
	ctx: SidebarContext,
) {
	if (!msg.chatId || !msg.lastReadAt) return;
	ctx.patchLastReadAt(msg.chatId, msg.lastReadAt);
}

export function handleChatListInvalidated(
	msg: ChatListRefreshRequestedMessage,
	ctx: SidebarContext,
) {
	if (!msg.chatId) return;
	ctx.refreshChats();
}
