import {
	chatViewSurfaceId,
	workspaceChatViewCount,
	type DesktopWorkspaceNode,
	type WorkspaceChatTile,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionDirection,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
} from './surface-types.js';
import {
	collectWindowNodes,
	mapWindows,
	removeWindowAndCollapse,
	windowCount,
	windowNodeById,
} from './window-tree.js';
import { activateTab, tabsWithOrder } from './workspace-window-tabs.js';

export function singleTabWindow(
	windowId: WorkspaceWindowId,
	surfaceId: string,
): WorkspaceWindowNode {
	return {
		type: 'window',
		id: windowId,
		tabs: { order: [surfaceId], activeId: surfaceId, mru: [surfaceId] },
	};
}

function replaceWindowTree(
	snapshot: WorkspaceLayoutSnapshot,
	desktopRoot: DesktopWorkspaceNode,
	removedSurfaceIds: readonly string[],
): WorkspaceLayoutSnapshot {
	const removed = new Set(removedSurfaceIds);
	const surfaces = { ...snapshot.surfaces };
	const unplacedTerminalIds = new Set(snapshot.unplacedTerminalIds);
	for (const surfaceId of removed) {
		const surface = surfaces[surfaceId];
		if (surface?.type === 'terminal') unplacedTerminalIds.add(surface.terminalId);
		delete surfaces[surfaceId];
	}
	const fallbackActiveId = collectWindowNodes(desktopRoot)[0]?.tabs.activeId;
	if (!fallbackActiveId) throw new Error('At least one workspace window must remain');
	return {
		...snapshot,
		desktopRoot,
		surfaces,
		fullscreenWindowId: null,
		mobileActiveSurfaceId: removed.has(snapshot.mobileActiveSurfaceId)
			? fallbackActiveId
			: snapshot.mobileActiveSurfaceId,
		mobileReturnStack: snapshot.mobileReturnStack.filter(
			(target) => !removed.has(target.invokerSurfaceId),
		),
		unplacedTerminalIds: [...unplacedTerminalIds],
	};
}

export function mergeWindow(
	snapshot: WorkspaceLayoutSnapshot,
	sourceWindowId: WorkspaceWindowId,
	destinationWindowId: WorkspaceWindowId,
): WorkspaceLayoutSnapshot {
	if (sourceWindowId === destinationWindowId) return snapshot;
	const source = windowNodeById(snapshot.desktopRoot, sourceWindowId);
	const destination = windowNodeById(snapshot.desktopRoot, destinationWindowId);
	if (!source || !destination) throw new Error('Cannot merge missing workspace windows');
	const sourceChatId = chatViewSurfaceId(sourceWindowId);
	const destinationChatId = chatViewSurfaceId(destinationWindowId);
	const sourceChat = snapshot.surfaces[sourceChatId];
	const transferChat = sourceChat?.type === 'chat' && !snapshot.surfaces[destinationChatId];
	const movedIds = source.tabs.order.flatMap((id) => {
		if (id !== sourceChatId) return [id];
		return transferChat ? [destinationChatId] : [];
	});
	const root = removeWindowAndCollapse(snapshot.desktopRoot, sourceWindowId)!;
	const merged = mapWindows(root, (window) =>
		window.id === destinationWindowId
			? { ...window, tabs: tabsWithOrder(window.tabs, [...window.tabs.order, ...movedIds]) }
			: window,
	);
	const next = replaceWindowTree(snapshot, merged, sourceChat ? [sourceChatId] : []);
	if (!transferChat) return next;
	return {
		...next,
		surfaces: { ...next.surfaces, [destinationChatId]: { ...sourceChat, id: destinationChatId } },
	};
}

// Bisecting groups keeps even wide grids within the partition ratio and restore-depth bounds.
function evenlyPartition(
	nodes: readonly DesktopWorkspaceNode[],
	direction: WorkspacePartitionDirection,
): DesktopWorkspaceNode {
	if (!nodes.length) throw new Error('A workspace tile group cannot be empty');
	if (nodes.length === 1) return nodes[0];
	const middle = Math.ceil(nodes.length / 2);
	return {
		type: 'partition',
		id: `partition-tile-${direction}-${nodes[middle].id}`,
		direction,
		ratio: middle / nodes.length,
		children: [
			evenlyPartition(nodes.slice(0, middle), direction),
			evenlyPartition(nodes.slice(middle), direction),
		],
	};
}

export function tileChats(
	snapshot: WorkspaceLayoutSnapshot,
	rows: readonly (readonly WorkspaceChatTile[])[],
): WorkspaceLayoutSnapshot {
	const tiledWindowIds = new Set(rows.flat().map((tile) => tile.windowId));
	const removedChatViews: string[] = [];
	const retainedTabs: string[] = [];
	for (const window of collectWindowNodes(snapshot.desktopRoot)) {
		if (tiledWindowIds.has(window.id)) continue;
		for (const id of window.tabs.order) {
			if (snapshot.surfaces[id].type === 'chat') removedChatViews.push(id);
			else retainedTabs.push(id);
		}
	}
	const surfaces = { ...snapshot.surfaces };
	const firstTile = rows[0]?.[0];
	function windowForTile(tile: WorkspaceChatTile): WorkspaceWindowNode {
		const surfaceId = chatViewSurfaceId(tile.windowId);
		surfaces[surfaceId] = { type: 'chat', id: surfaceId, chatId: tile.chatId };
		const window =
			windowNodeById(snapshot.desktopRoot, tile.windowId) ??
			singleTabWindow(tile.windowId, surfaceId);
		let order = window.tabs.order;
		if (!order.includes(surfaceId)) order = [surfaceId, ...order];
		if (tile === firstTile) order = [...order, ...retainedTabs];
		return { ...window, tabs: activateTab(tabsWithOrder(window.tabs, order), surfaceId) };
	}
	const rowNodes = rows.map((row) => evenlyPartition(row.map(windowForTile), 'horizontal'));
	return replaceWindowTree(
		{ ...snapshot, surfaces },
		evenlyPartition(rowNodes, 'vertical'),
		removedChatViews,
	);
}

export function closeWindow(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
): WorkspaceLayoutSnapshot {
	if (windowCount(snapshot.desktopRoot) === 1) {
		throw new Error('At least one workspace window must remain');
	}
	const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
	if (!workspaceWindow) throw new Error(`Workspace window does not exist: ${windowId}`);
	if (
		workspaceWindow.tabs.order.some((surfaceId) => snapshot.surfaces[surfaceId]?.type === 'chat') &&
		workspaceChatViewCount(snapshot) <= 1
	) {
		throw new Error('At least one Chat view must remain');
	}
	const root = removeWindowAndCollapse(snapshot.desktopRoot, windowId);
	if (!root) throw new Error('At least one workspace window must remain');
	return replaceWindowTree(snapshot, root, workspaceWindow.tabs.order);
}
