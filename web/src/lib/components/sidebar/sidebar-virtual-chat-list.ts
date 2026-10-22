import type { VirtualItem } from '$lib/virt/virtual-list-types.js';
import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';
import type { ChatItemLayout } from '$lib/layout/chat-item-layout.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

export const SINGLE_LINE_CHAT_ROW_HEIGHT = 40;
export const COMPACT_CHAT_ROW_HEIGHT = 62;
export const DESKTOP_CHAT_ROW_HEIGHT = 76;
export const PROJECT_PATH_LINE_HEIGHT = 18;
export const PROJECT_HEADER_ROW_HEIGHT = 32;
export const SECTION_HEADER_ROW_HEIGHT = 28;
export const EXECUTOR_HEADER_ROW_HEIGHT = 36;
export const DEFAULT_CHAT_ROW_OVERSCAN = 8;
export const CHAT_ROW_SEPARATOR_SLOT_HEIGHT = 2;

// Horizontal geometry shared by headers, chat rows, and separators. A header's
// label follows its 12px chevron and 6px gap, so a chat one level deeper starts
// exactly where its parent's label does.
const SIDEBAR_HEADER_BASE_INSET = 6;
const SIDEBAR_CHAT_BASE_INSET = 12;
const SIDEBAR_NESTING_STEP = 12;

export function sidebarHeaderInset(depth: number): number {
	return SIDEBAR_HEADER_BASE_INSET + depth * SIDEBAR_NESTING_STEP;
}

export function sidebarChatInset(depth: number): number {
	return SIDEBAR_CHAT_BASE_INSET + depth * SIDEBAR_NESTING_STEP;
}

export interface SidebarVirtualProjectHeaderRow {
	executorId?: string;
	type: 'project-header';
	key: string;
	/** Nesting level beneath executor and project headers; section labels do not nest. */
	depth: number;
	projectKey: string;
	collapseKey: string;
	projectPath: string;
	count: number;
	chatIds: string[];
	isCollapsed: boolean;
	/** True when an executor header already identifies this project's executor. */
	executorGrouped?: boolean;
	/** True when another project under the same executor shares this folder name. */
	showParentPath?: boolean;
}

export interface SidebarVirtualExecutorHeaderRow {
	type: 'executor-header';
	key: string;
	depth: number;
	executorId: string;
	collapseKey: string;
	count: number;
	chatIds: string[];
	isCollapsed: boolean;
}

export type SidebarChatSection =
	'active' | 'inactive' | 'archived' | 'in-progress' | 'ready-for-review' | 'caught-up';

// Cross-project sections share the project collapse store's key space.
export function sidebarSectionKey(section: SidebarChatSection, executorId?: string): string {
	return executorId === undefined
		? `section:${section}`
		: `executor:${executorId}:section:${section}`;
}

export function sidebarSectionProjectKey(section: SidebarChatSection, projectKey: string): string {
	return `${sidebarSectionKey(section)}:project:${projectKey}`;
}

export const SIDEBAR_SECTION_COLLAPSE_KEYS: readonly string[] = [
	sidebarSectionKey('active'),
	sidebarSectionKey('inactive'),
	sidebarSectionKey('archived'),
	sidebarSectionKey('in-progress'),
	sidebarSectionKey('ready-for-review'),
	sidebarSectionKey('caught-up'),
];

export interface SidebarVirtualSectionHeaderRow {
	type: 'section-header';
	executorId?: string;
	key: string;
	depth: number;
	section: SidebarChatSection;
	count: number;
	chatIds: string[];
	isCollapsed: boolean;
}

export interface SidebarVirtualChatRow {
	type: 'chat';
	key: string;
	depth: number;
	chat: ChatSessionRecord;
	list: PersistedChatOrderGroup;
	isPinned: boolean;
	isArchived: boolean;
	projectPath: string;
	groupProjectKey: string;
	groupProjectPath: string;
	reorderScopeKey: string;
	reorderScopeIds: string[];
	/** True when an executor header already identifies this chat's executor. */
	executorGrouped?: boolean;
	/** Section header the chat renders directly beneath, when it is not within a project. */
	section?: SidebarChatSection;
}

export type SidebarVirtualRow =
	| SidebarVirtualExecutorHeaderRow
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
	chatItemLayout: ChatItemLayout,
	showProjectPath = false,
): number {
	if (row?.type === 'executor-header') {
		return EXECUTOR_HEADER_ROW_HEIGHT;
	}
	if (row?.type === 'project-header') {
		return PROJECT_HEADER_ROW_HEIGHT;
	}
	if (row?.type === 'section-header') {
		return SECTION_HEADER_ROW_HEIGHT;
	}
	const pathHeight =
		showProjectPath && row?.chat.projectPath?.trim() ? PROJECT_PATH_LINE_HEIGHT : 0;
	switch (chatItemLayout) {
		case 'single-line':
			return SINGLE_LINE_CHAT_ROW_HEIGHT + pathHeight;
		case 'compact':
			return COMPACT_CHAT_ROW_HEIGHT + pathHeight;
		case 'detailed':
			return DESKTOP_CHAT_ROW_HEIGHT + pathHeight;
	}
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
	left: number;
	height: number;
}

// Positions the hairline separator inside each chat row's trailing separator
// slot, snapped to the physical pixel grid and starting at the row's content.
export function computeSidebarSeparatorItems(
	virtualItems: readonly VirtualItem[],
	rows: readonly SidebarVirtualRow[],
	separatorLineHeight: number,
	separatorPixelRatio: number,
): SidebarChatSeparatorItem[] {
	return virtualItems
		.flatMap((virtualItem) => {
			const row = rows[virtualItem.index];
			return row?.type === 'chat' ? [{ row, virtualItem }] : [];
		})
		.map(({ row, virtualItem }) => {
			const slotStart = virtualItem.start + virtualItem.size - CHAT_ROW_SEPARATOR_SLOT_HEIGHT;
			const slotEnd = virtualItem.start + virtualItem.size;
			const preferredTop = slotStart + (CHAT_ROW_SEPARATOR_SLOT_HEIGHT - separatorLineHeight) / 2;
			const top = clamp(
				snapCssPixel(preferredTop, separatorPixelRatio),
				slotStart,
				slotEnd - separatorLineHeight,
			);
			return {
				key: row.key,
				top,
				left: sidebarChatInset(row.depth),
				height: separatorLineHeight,
			};
		});
}
