import type { VirtualItem } from '$lib/virt/virtual-list-types.js';
import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';
import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export const DESKTOP_CHAT_ROW_HEIGHT = 88;
export const MOBILE_CHAT_ROW_HEIGHT = 88;
export const COMPACT_CHAT_ROW_HEIGHT = 70;
export const SINGLE_LINE_CHAT_ROW_HEIGHT = 40;
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

export type SidebarChatSection = 'inactive' | 'archived';

// Time-based sections group chats across projects; their collapse keys share
// the project collapse store's key space.
export function sidebarSectionKey(section: SidebarChatSection): string {
	return `section:${section}`;
}

export const SIDEBAR_SECTION_COLLAPSE_KEYS: readonly string[] = [
	sidebarSectionKey('inactive'),
	sidebarSectionKey('archived'),
];

export interface SidebarVirtualSectionHeaderRow {
	type: 'section-header';
	key: string;
	section: SidebarChatSection;
	count: number;
	chatIds: string[];
	isCollapsed: boolean;
}

export interface SidebarVirtualChatRow {
	type: 'chat';
	key: string;
	chat: ChatSessionRecord;
	list: PersistedChatOrderGroup;
	isPinned: boolean;
	isArchived: boolean;
	projectPath: string;
	groupProjectKey: string;
	groupProjectPath: string;
	showProjectPathInGroup: boolean;
	reorderScopeKey: string;
	reorderScopeIds: string[];
}

export type SidebarVirtualRow =
	| SidebarVirtualProjectHeaderRow
	| SidebarVirtualSectionHeaderRow
	| SidebarVirtualChatRow;

export type SidebarChatOrderMap = Record<PersistedChatOrderGroup, string[]>;

export interface SidebarRowModel {
	rows: SidebarVirtualRow[];
	visibleOrders: SidebarChatOrderMap;
	visibleChatIds: string[];
	reorderScopesByChatId: Map<string, string[]>;
	projectKeys: string[];
}

export function estimateSidebarVirtualRowSize(
	row: SidebarVirtualRow | undefined,
	chatItemLayout: SidebarChatItemLayout,
): number {
	if (row?.type === 'project-header' || row?.type === 'section-header') {
		return PROJECT_HEADER_ROW_HEIGHT;
	}
	if (chatItemLayout === 'compact') return COMPACT_CHAT_ROW_HEIGHT;
	if (chatItemLayout === 'single-line') return SINGLE_LINE_CHAT_ROW_HEIGHT;
	return DESKTOP_CHAT_ROW_HEIGHT;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

// Snaps a CSS pixel offset to the physical pixel grid of the given device ratio.
export function snapCssPixel(value: number, pixelRatio: number): number {
	const ratio = Math.max(pixelRatio, 1);
	return Math.round(value * ratio) / ratio;
}

export interface SidebarChatSeparatorItem {
	key: string | number;
	top: number;
	height: number;
}

// Positions the hairline separator inside each chat row's trailing separator
// slot, snapped to the physical pixel grid.
export function computeSidebarSeparatorItems(
	virtualItems: readonly VirtualItem[],
	rows: readonly SidebarVirtualRow[],
	separatorLineHeight: number,
	separatorPixelRatio: number,
): SidebarChatSeparatorItem[] {
	return virtualItems
		.filter((virtualItem) => rows[virtualItem.index]?.type === 'chat')
		.map((virtualItem) => {
			const slotStart = virtualItem.start + virtualItem.size - CHAT_ROW_SEPARATOR_SLOT_HEIGHT;
			const slotEnd = virtualItem.start + virtualItem.size;
			const preferredTop = slotStart + (CHAT_ROW_SEPARATOR_SLOT_HEIGHT - separatorLineHeight) / 2;
			const top = clamp(
				snapCssPixel(preferredTop, separatorPixelRatio),
				slotStart,
				slotEnd - separatorLineHeight,
			);
			return {
				key: rows[virtualItem.index]?.key ?? virtualItem.key,
				top,
				height: separatorLineHeight,
			};
		});
}
