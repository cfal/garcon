export const DESKTOP_LAYOUT_PANES = ['chat-list', 'main', 'workspace-sidebar'] as const;

export type DesktopLayoutPane = (typeof DESKTOP_LAYOUT_PANES)[number];
export type DesktopLayoutOrder = [DesktopLayoutPane, DesktopLayoutPane, DesktopLayoutPane];
export type DesktopLayoutEdge = 'start' | 'end';
export type DesktopToolbarAlignment = 'start' | 'end';

export const DEFAULT_DESKTOP_LAYOUT_ORDER: DesktopLayoutOrder = [
	'chat-list',
	'main',
	'workspace-sidebar',
];

export interface DesktopLayoutPlacement {
	chatListEdge: DesktopLayoutEdge;
	workspaceSidebarEdge: DesktopLayoutEdge;
	workspaceSidebarBeforeMain: boolean;
	mainToolbarAlignment: DesktopToolbarAlignment;
	workspaceSidebarToolbarAlignment: DesktopToolbarAlignment;
}

export interface DesktopPaneWidths {
	chatList: number;
	workspaceSidebar: number;
}

export interface MainInlineInsets {
	start: number;
	end: number;
}

export function isDesktopLayoutPane(value: unknown): value is DesktopLayoutPane {
	return typeof value === 'string' && DESKTOP_LAYOUT_PANES.includes(value as DesktopLayoutPane);
}

export function normalizeDesktopLayoutOrder(value: unknown): DesktopLayoutOrder {
	if (!Array.isArray(value) || value.length !== DESKTOP_LAYOUT_PANES.length) {
		return [...DEFAULT_DESKTOP_LAYOUT_ORDER];
	}
	if (!value.every(isDesktopLayoutPane)) {
		return [...DEFAULT_DESKTOP_LAYOUT_ORDER];
	}
	if (new Set(value).size !== DESKTOP_LAYOUT_PANES.length) {
		return [...DEFAULT_DESKTOP_LAYOUT_ORDER];
	}
	return [value[0], value[1], value[2]] as DesktopLayoutOrder;
}

export function resolveDesktopLayout(order: DesktopLayoutOrder): DesktopLayoutPlacement {
	const index = (pane: DesktopLayoutPane): number => order.indexOf(pane);
	const mainIndex = index('main');
	const workspaceSidebarBeforeMain = index('workspace-sidebar') < mainIndex;

	return {
		chatListEdge: index('chat-list') < mainIndex ? 'end' : 'start',
		workspaceSidebarEdge: workspaceSidebarBeforeMain ? 'end' : 'start',
		workspaceSidebarBeforeMain,
		mainToolbarAlignment: workspaceSidebarBeforeMain ? 'start' : 'end',
		workspaceSidebarToolbarAlignment: workspaceSidebarBeforeMain ? 'end' : 'start',
	};
}

export function resolveWorkspaceSidebarOverlayInsets(
	order: DesktopLayoutOrder,
	chatListWidth: number,
): MainInlineInsets {
	const mainIndex = order.indexOf('main');
	const sidebarIndex = order.indexOf('workspace-sidebar');
	const chatListIndex = order.indexOf('chat-list');
	const sidebarBeforeMain = sidebarIndex < mainIndex;
	const chatListOutsideSidebar = sidebarBeforeMain
		? chatListIndex < sidebarIndex
		: chatListIndex > sidebarIndex;
	const edgeInset = chatListOutsideSidebar ? chatListWidth : 0;

	return sidebarBeforeMain ? { start: edgeInset, end: 0 } : { start: 0, end: edgeInset };
}

export function resolveMainInlineInsets(
	order: DesktopLayoutOrder,
	widths: DesktopPaneWidths,
): MainInlineInsets {
	const mainIndex = order.indexOf('main');
	let start = 0;
	let end = 0;

	for (const [index, pane] of order.entries()) {
		const width =
			pane === 'chat-list'
				? widths.chatList
				: pane === 'workspace-sidebar'
					? widths.workspaceSidebar
					: 0;
		if (index < mainIndex) start += width;
		if (index > mainIndex) end += width;
	}

	return { start, end };
}

export function moveDesktopLayoutPane(
	order: DesktopLayoutOrder,
	fromIndex: number,
	toIndex: number,
): DesktopLayoutOrder {
	if (fromIndex < 0 || fromIndex >= order.length) return [...order];
	const next = [...order];
	const [pane] = next.splice(fromIndex, 1);
	if (!pane) return [...order];
	next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, pane);
	return normalizeDesktopLayoutOrder(next);
}
