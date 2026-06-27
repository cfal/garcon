import type { ChatOrderList } from '$lib/api/chats.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export const DESKTOP_CHAT_ROW_HEIGHT = 88;
export const MOBILE_CHAT_ROW_HEIGHT = 88;
export const COMPACT_CHAT_ROW_HEIGHT = 70;
export const PROJECT_HEADER_ROW_HEIGHT = 32;
export const DEFAULT_CHAT_ROW_OVERSCAN = 8;
export const CHAT_ROW_SEPARATOR_SLOT_HEIGHT = 2;

export interface SidebarVirtualProjectHeaderRow {
	type: 'project-header';
	key: string;
	projectKey: string;
	projectPath: string;
	count: number;
	chatIds: string[];
	isCollapsed: boolean;
}

export interface SidebarVirtualChatRow {
	type: 'chat';
	key: string;
	chat: ChatSessionRecord;
	list: ChatOrderList;
	isPinned: boolean;
	isArchived: boolean;
	projectPath: string;
	reorderScopeKey: string;
	reorderScopeIds: string[];
}

export type SidebarVirtualRow = SidebarVirtualProjectHeaderRow | SidebarVirtualChatRow;

export type SidebarChatOrderMap = Record<ChatOrderList, string[]>;

export interface SidebarRowModel {
	rows: SidebarVirtualRow[];
	visibleOrders: SidebarChatOrderMap;
	visibleChatIds: string[];
	reorderScopesByChatId: Map<string, string[]>;
	projectKeys: string[];
}

export function estimateSidebarVirtualRowSize(
	row: SidebarVirtualRow | undefined,
	showLastLineRow: boolean,
): number {
	if (row?.type === 'project-header') return PROJECT_HEADER_ROW_HEIGHT;
	return showLastLineRow ? DESKTOP_CHAT_ROW_HEIGHT : COMPACT_CHAT_ROW_HEIGHT;
}
