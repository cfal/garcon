import {
	chatViewSurfaceId,
	workspaceChatViewCount,
	type DesktopWorkspaceNode,
	type WorkspaceChatTile,
	type WorkspaceLayoutSnapshot,
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
import { evenlyPartition } from './workspace-chat-tiling.js';

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

function removeOwnedSurfaceDescriptors(
	snapshot: WorkspaceLayoutSnapshot,
	removedSurfaceIds: readonly string[],
	desktopRoot: DesktopWorkspaceNode,
	fullscreenWindowId: WorkspaceWindowId | null,
): WorkspaceLayoutSnapshot {
	const removed = new Set(removedSurfaceIds);
	const surfaces = { ...snapshot.surfaces };
	const unplacedTerminalIds = [...snapshot.unplacedTerminalIds];
	for (const surfaceId of removed) {
		const surface = surfaces[surfaceId];
		if (surface?.type === 'terminal') unplacedTerminalIds.push(surface.terminalId);
		delete surfaces[surfaceId];
	}
	const fallbackActiveId = collectWindowNodes(desktopRoot)[0]?.tabs.activeId;
	if (!fallbackActiveId) throw new Error('At least one workspace window must remain');
	return {
		...snapshot,
		desktopRoot,
		surfaces,
		fullscreenWindowId,
		mobileActiveSurfaceId: removed.has(snapshot.mobileActiveSurfaceId)
			? fallbackActiveId
			: snapshot.mobileActiveSurfaceId,
		mobileReturnStack: snapshot.mobileReturnStack.filter(
			(target) => !removed.has(target.invokerSurfaceId),
		),
		unplacedTerminalIds: [...new Set(unplacedTerminalIds)],
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
	const next = removeOwnedSurfaceDescriptors(
		snapshot,
		sourceChat ? [sourceChatId] : [],
		merged,
		null,
	);
	if (!transferChat) return next;
	return {
		...next,
		surfaces: { ...next.surfaces, [destinationChatId]: { ...sourceChat, id: destinationChatId } },
	};
}

export function tileChats(
	snapshot: WorkspaceLayoutSnapshot,
	rows: readonly (readonly WorkspaceChatTile[])[],
): WorkspaceLayoutSnapshot {
	const windows = collectWindowNodes(snapshot.desktopRoot);
	const survivors = new Set(rows.flat().map((tile) => tile.windowId));
	const spareTabs = windows
		.filter((window) => !survivors.has(window.id))
		.flatMap((window) => window.tabs.order);
	const removedChatViews = spareTabs.filter((id) => snapshot.surfaces[id].type === 'chat');
	const retainedTabs = spareTabs.filter((id) => snapshot.surfaces[id].type !== 'chat');
	const surfaces = { ...snapshot.surfaces };
	const rowNodes = rows.map((row, y) =>
		evenlyPartition(
			row.map(({ windowId, chatId }, x) => {
				const surfaceId = chatViewSurfaceId(windowId);
				surfaces[surfaceId] = { type: 'chat', id: surfaceId, chatId };
				const window =
					windows.find((candidate) => candidate.id === windowId) ??
					singleTabWindow(windowId, surfaceId);
				const order = window.tabs.order.includes(surfaceId)
					? window.tabs.order
					: [surfaceId, ...window.tabs.order];
				const tabs = tabsWithOrder(
					window.tabs,
					x === 0 && y === 0 ? [...order, ...retainedTabs] : order,
				);
				return { ...window, tabs: activateTab(tabs, surfaceId) };
			}),
			'horizontal',
		),
	);
	return removeOwnedSurfaceDescriptors(
		{ ...snapshot, surfaces },
		removedChatViews,
		evenlyPartition(rowNodes, 'vertical'),
		null,
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
	return removeOwnedSurfaceDescriptors(snapshot, workspaceWindow.tabs.order, root, null);
}
