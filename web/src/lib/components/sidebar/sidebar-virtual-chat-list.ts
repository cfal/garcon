import type { ChatOrderList } from '$lib/api/chats.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export const DESKTOP_CHAT_ROW_HEIGHT = 88;
export const MOBILE_CHAT_ROW_HEIGHT = 88;
export const DEFAULT_CHAT_ROW_OVERSCAN = 8;

export interface SidebarVirtualChatRow {
	type: 'chat';
	key: string;
	chat: ChatSessionRecord;
	list: ChatOrderList;
	isPinned: boolean;
	isArchived: boolean;
}
