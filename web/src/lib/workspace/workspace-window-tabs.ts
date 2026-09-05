import type { WorkspaceWindowTabState } from './surface-types.js';

export function tabsWithOrder(
	tabs: WorkspaceWindowTabState,
	order: readonly string[],
): WorkspaceWindowTabState {
	const nextOrder = [...new Set(order)];
	if (nextOrder.length === 0) throw new Error('A workspace window cannot be empty');
	const nextMru = [...new Set(tabs.mru)].filter((id) => nextOrder.includes(id));
	for (const id of nextOrder) {
		if (!nextMru.includes(id)) nextMru.push(id);
	}
	const activeId = nextOrder.includes(tabs.activeId) ? tabs.activeId : (nextMru[0] ?? nextOrder[0]);
	return { order: nextOrder, activeId, mru: nextMru };
}

export function activateTab(
	tabs: WorkspaceWindowTabState,
	surfaceId: string,
): WorkspaceWindowTabState {
	if (!tabs.order.includes(surfaceId)) {
		throw new Error(`Surface is not in the workspace window: ${surfaceId}`);
	}
	return {
		order: [...tabs.order],
		activeId: surfaceId,
		mru: [surfaceId, ...tabs.mru.filter((id) => id !== surfaceId)],
	};
}

export function insertTab(
	tabs: WorkspaceWindowTabState,
	surfaceId: string,
	index?: number,
): WorkspaceWindowTabState {
	const without = tabs.order.filter((id) => id !== surfaceId);
	const insertionIndex =
		index === undefined ? without.length : Math.max(0, Math.min(without.length, Math.trunc(index)));
	without.splice(insertionIndex, 0, surfaceId);
	return tabsWithOrder(tabs, without);
}

export function removeTab(
	tabs: WorkspaceWindowTabState,
	surfaceId: string,
): WorkspaceWindowTabState | null {
	const order = tabs.order.filter((id) => id !== surfaceId);
	if (order.length === 0) return null;
	return tabsWithOrder({ ...tabs, mru: tabs.mru.filter((id) => id !== surfaceId) }, order);
}
