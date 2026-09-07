// Pure DOM lookup helpers for the virtualized sidebar chat list. Kept free of
// drag/reorder state so the sortable list component orchestrates them without
// owning geometry details.

import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import { sidebarSectionKey, type SidebarVirtualRow } from './sidebar-virtual-chat-list';

export function pointIsInsideViewport(
	viewport: HTMLElement,
	clientX: number,
	clientY: number,
): boolean {
	const rect = viewport.getBoundingClientRect();
	return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

export function mountedRowAtPoint(clientX: number, clientY: number): HTMLElement | null {
	const target = document.elementFromPoint(clientX, clientY);
	if (!(target instanceof Element)) return null;
	return target.closest<HTMLElement>('[data-sidebar-virtual-row]');
}

export function mountedVirtualItemAtPoint(clientX: number, clientY: number): HTMLElement | null {
	const target = document.elementFromPoint(clientX, clientY);
	if (!(target instanceof Element)) return null;
	return target.closest<HTMLElement>('[data-sidebar-virtual-item]');
}

export function mountedChatRowIds(container: HTMLElement | null): string[] {
	if (!container) return [];
	return Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-virtual-row]'))
		.map((element) => element.dataset.sidebarVirtualRow)
		.filter((id): id is string => Boolean(id));
}

export function closestEdgeForRow(rowEl: HTMLElement, clientY: number): Edge {
	const rect = rowEl.getBoundingClientRect();
	return clientY < rect.top + rect.height / 2 ? 'top' : 'bottom';
}

export interface SidebarScrollTarget {
	index: number;
	chatId?: string;
	projectKey?: string;
	sectionKey?: string;
}

// Resolves a chat to a scroll anchor: its own row when mounted, otherwise the
// collapsed project or time-section header containing it.
export function sidebarScrollTargetForChat(
	rows: readonly SidebarVirtualRow[],
	chatId: string,
): SidebarScrollTarget | null {
	const chatIndex = rows.findIndex((row) => row.type === 'chat' && row.chat.id === chatId);
	if (chatIndex >= 0) return { index: chatIndex, chatId };

	const headerIndex = rows.findIndex(
		(row) =>
			(row.type === 'project-header' || row.type === 'section-header') && row.chatIds.includes(chatId),
	);
	const headerRow = headerIndex >= 0 ? rows[headerIndex] : null;
	if (headerRow?.type === 'project-header') {
		return { index: headerIndex, projectKey: headerRow.projectKey };
	}
	if (headerRow?.type === 'section-header') {
		return { index: headerIndex, sectionKey: sidebarSectionKey(headerRow.section) };
	}
	return null;
}

export function mountedElementForScrollTarget(
	viewport: HTMLElement | null,
	target: SidebarScrollTarget,
): HTMLElement | null {
	if (!viewport) return null;
	if (target.chatId) {
		return findMountedElement(viewport, '[data-sidebar-virtual-row]', 'sidebarVirtualRow', target.chatId);
	}
	if (target.projectKey) {
		return findMountedElement(viewport, '[data-sidebar-project-key]', 'sidebarProjectKey', target.projectKey);
	}
	if (target.sectionKey) {
		return findMountedElement(viewport, '[data-sidebar-section-key]', 'sidebarSectionKey', target.sectionKey);
	}
	return null;
}

function findMountedElement(
	viewport: HTMLElement,
	selector: string,
	datasetKey: 'sidebarVirtualRow' | 'sidebarProjectKey' | 'sidebarSectionKey',
	value: string,
): HTMLElement | null {
	return (
		Array.from(viewport.querySelectorAll<HTMLElement>(selector)).find(
			(element) => element.dataset[datasetKey] === value,
		) ?? null
	);
}
