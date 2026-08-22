import type { VirtualItem } from '@tanstack/virtual-core';
import type { PersistedChatOrderGroup } from '$shared/chat-order-contracts';
import type { SidebarChatItemLayout } from '$lib/stores/local-settings.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

export const DESKTOP_CHAT_ROW_HEIGHT = 88;
export const MOBILE_CHAT_ROW_HEIGHT = 88;
export const COMPACT_CHAT_ROW_HEIGHT = 70;
export const SINGLE_LINE_CHAT_ROW_HEIGHT = 46;
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

export type SidebarVirtualRow = SidebarVirtualProjectHeaderRow | SidebarVirtualChatRow;

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
	if (row?.type === 'project-header') return PROJECT_HEADER_ROW_HEIGHT;
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
	virtualItems: VirtualItem[],
	rows: SidebarVirtualRow[],
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

export interface SidebarScrollAnchor {
	key: string | number;
	offset: number;
	size: number;
}

// Captures which virtual row anchors the viewport so a size re-estimation can
// keep the same row visible at the same relative intra-row position.
export function findSidebarScrollAnchor(
	virtualItems: VirtualItem[],
	scrollTop: number,
): SidebarScrollAnchor | null {
	const item = virtualItems.find((virtualItem) => virtualItem.start + virtualItem.size > scrollTop);
	if (!item) return null;
	return {
		key: item.key as string | number,
		offset: scrollTop - item.start,
		size: item.size,
	};
}

// Computes the anchored row's absolute top from the full row list; the anchor
// row typically falls outside the post-switch visible window, so it cannot be
// resolved from the visible virtual items alone. The intra-row offset is
// normalized by the old and new row heights so a shrinking or growing row
// keeps the anchor row itself inside the viewport.
export function anchoredSidebarRowTop(
	rows: SidebarVirtualRow[],
	anchor: SidebarScrollAnchor,
	chatItemLayout: SidebarChatItemLayout,
): number | null {
	let top = 0;
	for (const row of rows) {
		if (row.key === anchor.key) {
			const size = estimateSidebarVirtualRowSize(row, chatItemLayout);
			const normalizedOffset = (anchor.offset / anchor.size) * size;
			return top + Math.min(Math.round(normalizedOffset), size);
		}
		top += estimateSidebarVirtualRowSize(row, chatItemLayout);
	}
	return null;
}
