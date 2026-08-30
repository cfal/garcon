import {
	MAX_MOBILE_RETURN_TARGETS,
	MAX_WORKSPACE_WINDOWS,
	chatViewSurfaceId,
	isPortableSingleton,
	terminalSurfaceId,
	workspaceChatViewCount,
	type DesktopWorkspaceNode,
	type MobileReturnTarget,
	type SurfaceDescriptor,
	type WorkspaceLayoutCommitPort,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutReader,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
	type WorkspaceWindowTabState,
} from './surface-types.js';
import {
	clampPartitionRatio,
	collectWindowNodes,
	insertWindowAtEdge,
	mapPartitions,
	mapWindows,
	projectedWindowCountAfterTabMove,
	removeWindowAndCollapse,
	windowCount,
	windowIdOfSurface,
	windowNodeById,
} from './window-tree.js';
import { canonicalWorkspaceSnapshot } from './canonical-layout.js';

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function tabsWithOrder(
	tabs: WorkspaceWindowTabState,
	order: readonly string[],
): WorkspaceWindowTabState {
	const nextOrder = unique(order);
	if (nextOrder.length === 0) throw new Error('A workspace window cannot be empty');
	const nextMru = unique(tabs.mru).filter((id) => nextOrder.includes(id));
	for (const id of nextOrder) {
		if (!nextMru.includes(id)) nextMru.push(id);
	}
	const activeId = nextOrder.includes(tabs.activeId) ? tabs.activeId : (nextMru[0] ?? nextOrder[0]);
	return { order: nextOrder, activeId, mru: nextMru };
}

function activateTab(tabs: WorkspaceWindowTabState, surfaceId: string): WorkspaceWindowTabState {
	if (!tabs.order.includes(surfaceId)) {
		throw new Error(`Surface is not in the workspace window: ${surfaceId}`);
	}
	return {
		order: [...tabs.order],
		activeId: surfaceId,
		mru: [surfaceId, ...tabs.mru.filter((id) => id !== surfaceId)],
	};
}

function insertTab(
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

function removeTab(
	tabs: WorkspaceWindowTabState,
	surfaceId: string,
): WorkspaceWindowTabState | null {
	const order = tabs.order.filter((id) => id !== surfaceId);
	if (order.length === 0) return null;
	return tabsWithOrder({ ...tabs, mru: tabs.mru.filter((id) => id !== surfaceId) }, order);
}

function singleTabWindow(windowId: WorkspaceWindowId, surfaceId: string): WorkspaceWindowNode {
	return {
		type: 'window',
		id: windowId,
		tabs: { order: [surfaceId], activeId: surfaceId, mru: [surfaceId] },
	};
}

function normalizeReturnStack(stack: readonly MobileReturnTarget[]): MobileReturnTarget[] {
	const normalized: MobileReturnTarget[] = [];
	for (const target of stack) {
		if (!target || typeof target.invokerSurfaceId !== 'string' || !target.invokerSurfaceId) {
			continue;
		}
		if (typeof target.invokerHost !== 'string' || !target.invokerHost) continue;
		if (typeof target.routeIdentity !== 'string') continue;
		const duplicateIndex = normalized.findIndex(
			(item) =>
				item.invokerSurfaceId === target.invokerSurfaceId &&
				item.routeIdentity === target.routeIdentity,
		);
		if (duplicateIndex >= 0) normalized.splice(duplicateIndex, 1);
		normalized.push({ ...target });
	}
	return normalized.slice(-MAX_MOBILE_RETURN_TARGETS);
}

function removeSurfaceFromTree(
	node: DesktopWorkspaceNode,
	surfaceId: string,
): DesktopWorkspaceNode | null {
	if (node.type === 'window') {
		if (!node.tabs.order.includes(surfaceId)) return node;
		const tabs = removeTab(node.tabs, surfaceId);
		return tabs ? { ...node, tabs } : null;
	}
	const first = removeSurfaceFromTree(node.children[0], surfaceId);
	const second = removeSurfaceFromTree(node.children[1], surfaceId);
	if (!first) return second;
	if (!second) return first;
	if (first === node.children[0] && second === node.children[1]) return node;
	return { ...node, children: [first, second] };
}

function removeEveryPlacement(
	snapshot: WorkspaceLayoutSnapshot,
	surfaceId: string,
): WorkspaceLayoutSnapshot {
	const root = removeSurfaceFromTree(snapshot.desktopRoot, surfaceId);
	if (!root) throw new Error('At least one workspace window must remain');
	return {
		...snapshot,
		desktopRoot: root,
		fullscreenWindowId:
			snapshot.fullscreenWindowId && windowNodeById(root, snapshot.fullscreenWindowId)
				? snapshot.fullscreenWindowId
				: null,
		dialogFileSurfaceId:
			snapshot.dialogFileSurfaceId === surfaceId ? null : snapshot.dialogFileSurfaceId,
		mobileOnlySurfaceIds: snapshot.mobileOnlySurfaceIds.filter((id) => id !== surfaceId),
	};
}

function registerSurface(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'register-surface' }>,
): WorkspaceLayoutSnapshot {
	if (mutation.surface.type === 'chat') {
		throw new Error('Chat views must be created with a window Chat mutation');
	}
	if (snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Surface already exists: ${mutation.surface.id}`);
	}
	if (
		!mutation.windowId &&
		mutation.surface.type !== 'file' &&
		!isPortableSingleton(mutation.surface)
	) {
		throw new Error('Only file and portable singleton surfaces may be mobile-only');
	}
	const placedTerminalId =
		mutation.surface.type === 'terminal' ? mutation.surface.terminalId : null;
	const next: WorkspaceLayoutSnapshot = {
		...snapshot,
		surfaces: { ...snapshot.surfaces, [mutation.surface.id]: mutation.surface },
		unplacedTerminalIds: placedTerminalId
			? snapshot.unplacedTerminalIds.filter((terminalId) => terminalId !== placedTerminalId)
			: snapshot.unplacedTerminalIds,
	};
	if (!mutation.windowId) {
		return {
			...next,
			mobileOnlySurfaceIds: [...next.mobileOnlySurfaceIds, mutation.surface.id],
		};
	}
	if (!windowNodeById(next.desktopRoot, mutation.windowId)) {
		throw new Error(`Workspace window does not exist: ${mutation.windowId}`);
	}
	return {
		...next,
		desktopRoot: mapWindows(next.desktopRoot, (workspaceWindow) =>
			workspaceWindow.id === mutation.windowId
				? {
						...workspaceWindow,
						tabs: insertTab(workspaceWindow.tabs, mutation.surface.id, mutation.index),
					}
				: workspaceWindow,
		),
	};
}

function registerSurfaceInNewWindow(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'register-surface-in-new-window' }>,
): WorkspaceLayoutSnapshot {
	if (mutation.surface.type === 'chat') {
		throw new Error('Chat views must be created with open-chat-in-new-window');
	}
	if (snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Surface already exists: ${mutation.surface.id}`);
	}
	if (!windowNodeById(snapshot.desktopRoot, mutation.targetWindowId)) {
		throw new Error(`Workspace window does not exist: ${mutation.targetWindowId}`);
	}
	if (windowCount(snapshot.desktopRoot) >= MAX_WORKSPACE_WINDOWS) {
		throw new Error('Workspace window count limit reached');
	}
	if (windowNodeById(snapshot.desktopRoot, mutation.newWindowId)) {
		throw new Error(`Workspace window already exists: ${mutation.newWindowId}`);
	}
	const placedTerminalId =
		mutation.surface.type === 'terminal' ? mutation.surface.terminalId : null;
	return {
		...snapshot,
		desktopRoot: insertWindowAtEdge(
			snapshot.desktopRoot,
			mutation.targetWindowId,
			mutation.edge,
			singleTabWindow(mutation.newWindowId, mutation.surface.id),
			mutation.partitionId,
		),
		surfaces: { ...snapshot.surfaces, [mutation.surface.id]: mutation.surface },
		fullscreenWindowId: null,
		unplacedTerminalIds: placedTerminalId
			? snapshot.unplacedTerminalIds.filter((terminalId) => terminalId !== placedTerminalId)
			: snapshot.unplacedTerminalIds,
	};
}

function setWindowChat(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
	chatId: string | null,
	index = 0,
): WorkspaceLayoutSnapshot {
	const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
	if (!workspaceWindow) throw new Error(`Workspace window does not exist: ${windowId}`);
	const surfaceId = chatViewSurfaceId(windowId);
	const existing = snapshot.surfaces[surfaceId];
	if (existing && existing.type !== 'chat') {
		throw new Error(`Chat view identity is occupied: ${surfaceId}`);
	}
	const otherChat = workspaceWindow.tabs.order.find(
		(id) => snapshot.surfaces[id]?.type === 'chat' && id !== surfaceId,
	);
	if (otherChat) throw new Error(`Workspace window already contains a Chat view: ${windowId}`);
	const descriptor: SurfaceDescriptor = { id: surfaceId, type: 'chat', chatId };
	return {
		...snapshot,
		surfaces: { ...snapshot.surfaces, [surfaceId]: descriptor },
		desktopRoot: mapWindows(snapshot.desktopRoot, (candidate) => {
			if (candidate.id !== windowId) return candidate;
			const tabs = candidate.tabs.order.includes(surfaceId)
				? candidate.tabs
				: insertTab(candidate.tabs, surfaceId, index);
			return { ...candidate, tabs: activateTab(tabs, surfaceId) };
		}),
	};
}

function openChatInNewWindow(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'open-chat-in-new-window' }>,
): WorkspaceLayoutSnapshot {
	if (!windowNodeById(snapshot.desktopRoot, mutation.targetWindowId)) {
		throw new Error(`Workspace window does not exist: ${mutation.targetWindowId}`);
	}
	if (windowCount(snapshot.desktopRoot) >= MAX_WORKSPACE_WINDOWS) {
		throw new Error('Workspace window count limit reached');
	}
	if (windowNodeById(snapshot.desktopRoot, mutation.newWindowId)) {
		throw new Error(`Workspace window already exists: ${mutation.newWindowId}`);
	}
	const surfaceId = chatViewSurfaceId(mutation.newWindowId);
	if (snapshot.surfaces[surfaceId]) throw new Error(`Surface already exists: ${surfaceId}`);
	return {
		...snapshot,
		desktopRoot: insertWindowAtEdge(
			snapshot.desktopRoot,
			mutation.targetWindowId,
			mutation.edge,
			singleTabWindow(mutation.newWindowId, surfaceId),
			mutation.partitionId,
		),
		surfaces: {
			...snapshot.surfaces,
			[surfaceId]: { id: surfaceId, type: 'chat', chatId: mutation.chatId },
		},
		fullscreenWindowId: null,
	};
}

function replaceSurface(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'replace-surface' }>,
): WorkspaceLayoutSnapshot {
	const previous = snapshot.surfaces[mutation.previousId];
	if (!previous) throw new Error(`Surface does not exist: ${mutation.previousId}`);
	if (previous.type === 'chat' || mutation.surface.type === 'chat') {
		throw new Error('Chat views cannot be replaced through generic surface replacement');
	}
	if (mutation.previousId !== mutation.surface.id && snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Replacement surface already exists: ${mutation.surface.id}`);
	}
	const replaceId = (ids: readonly string[]) =>
		ids.map((id) => (id === mutation.previousId ? mutation.surface.id : id));
	const replaceTabs = (tabs: WorkspaceWindowTabState): WorkspaceWindowTabState => ({
		order: replaceId(tabs.order),
		activeId: tabs.activeId === mutation.previousId ? mutation.surface.id : tabs.activeId,
		mru: replaceId(tabs.mru),
	});
	const surfaces = { ...snapshot.surfaces };
	delete surfaces[mutation.previousId];
	surfaces[mutation.surface.id] = mutation.surface;
	let unplacedTerminalIds = [...snapshot.unplacedTerminalIds];
	if (
		previous.type === 'terminal' &&
		(mutation.surface.type !== 'terminal' || previous.terminalId !== mutation.surface.terminalId)
	) {
		unplacedTerminalIds = unique([...unplacedTerminalIds, previous.terminalId]);
	}
	if (mutation.surface.type === 'terminal') {
		const terminalId = mutation.surface.terminalId;
		unplacedTerminalIds = unplacedTerminalIds.filter((candidate) => candidate !== terminalId);
	}
	return {
		...snapshot,
		desktopRoot: mapWindows(snapshot.desktopRoot, (workspaceWindow) => ({
			...workspaceWindow,
			tabs: replaceTabs(workspaceWindow.tabs),
		})),
		surfaces,
		dialogFileSurfaceId:
			snapshot.dialogFileSurfaceId === mutation.previousId
				? mutation.surface.id
				: snapshot.dialogFileSurfaceId,
		mobileActiveSurfaceId:
			snapshot.mobileActiveSurfaceId === mutation.previousId
				? mutation.surface.id
				: snapshot.mobileActiveSurfaceId,
		mobileOnlySurfaceIds: replaceId(snapshot.mobileOnlySurfaceIds),
		mobileReturnStack: snapshot.mobileReturnStack.map((target) => ({
			...target,
			invokerSurfaceId:
				target.invokerSurfaceId === mutation.previousId
					? mutation.surface.id
					: target.invokerSurfaceId,
		})),
		unplacedTerminalIds,
	};
}

function updateTerminalPlacement(
	snapshot: WorkspaceLayoutSnapshot,
	terminalId: string,
	placement: 'unplaced' | 'forgotten',
): WorkspaceLayoutSnapshot {
	const surfaceId = terminalSurfaceId(terminalId);
	const surface = snapshot.surfaces[surfaceId];
	if (surface && (surface.type !== 'terminal' || surface.terminalId !== terminalId)) {
		throw new Error(`Terminal surface identity mismatch: ${surfaceId}`);
	}
	const next = surface ? removeEveryPlacement(snapshot, surfaceId) : snapshot;
	const surfaces = { ...next.surfaces };
	delete surfaces[surfaceId];
	return normalizeFullscreenWindow({
		...next,
		surfaces,
		mobileActiveSurfaceId:
			next.mobileActiveSurfaceId === surfaceId ? defaultActiveId(next) : next.mobileActiveSurfaceId,
		mobileReturnStack: next.mobileReturnStack.filter(
			(target) => target.invokerSurfaceId !== surfaceId,
		),
		unplacedTerminalIds:
			placement === 'unplaced'
				? unique([...next.unplacedTerminalIds, terminalId])
				: next.unplacedTerminalIds.filter((id) => id !== terminalId),
	});
}

function swapTerminalPlacements(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'swap-terminal-placements' }>,
): WorkspaceLayoutSnapshot {
	const first = snapshot.surfaces[mutation.firstSurfaceId];
	const second = snapshot.surfaces[mutation.secondSurfaceId];
	if (first?.type !== 'terminal' || second?.type !== 'terminal') {
		throw new Error('Only terminal surface placements can be swapped');
	}
	const swapId = (id: string): string => {
		if (id === mutation.firstSurfaceId) return mutation.secondSurfaceId;
		if (id === mutation.secondSurfaceId) return mutation.firstSurfaceId;
		return id;
	};
	const swapTabs = (tabs: WorkspaceWindowTabState): WorkspaceWindowTabState => ({
		order: tabs.order.map(swapId),
		activeId: swapId(tabs.activeId),
		mru: tabs.mru.map(swapId),
	});
	return {
		...snapshot,
		desktopRoot: mapWindows(snapshot.desktopRoot, (workspaceWindow) => ({
			...workspaceWindow,
			tabs: swapTabs(workspaceWindow.tabs),
		})),
		mobileActiveSurfaceId: swapId(snapshot.mobileActiveSurfaceId),
		mobileReturnStack: snapshot.mobileReturnStack.map((target) => ({
			...target,
			invokerSurfaceId: swapId(target.invokerSurfaceId),
		})),
	};
}

function movableWindowChat(snapshot: WorkspaceLayoutSnapshot, windowId: WorkspaceWindowId) {
	const workspaceWindow = windowNodeById(snapshot.desktopRoot, windowId);
	if (!workspaceWindow) throw new Error(`Workspace window does not exist: ${windowId}`);
	const surfaceId = chatViewSurfaceId(windowId);
	const surface = snapshot.surfaces[surfaceId];
	if (surface?.type !== 'chat' || !workspaceWindow.tabs.order.includes(surfaceId)) {
		throw new Error(`Workspace window does not contain its Chat view: ${windowId}`);
	}
	if (!surface.chatId) throw new Error(`Workspace Chat view is empty: ${windowId}`);
	return { surfaceId, chatId: surface.chatId };
}

function rekeyChatSurfaceReferences(
	snapshot: WorkspaceLayoutSnapshot,
	previousId: string,
	nextId: string,
): WorkspaceLayoutSnapshot {
	return {
		...snapshot,
		mobileActiveSurfaceId:
			snapshot.mobileActiveSurfaceId === previousId ? nextId : snapshot.mobileActiveSurfaceId,
		mobileReturnStack: snapshot.mobileReturnStack.map((target) => ({
			...target,
			invokerSurfaceId: target.invokerSurfaceId === previousId ? nextId : target.invokerSurfaceId,
		})),
	};
}

function moveTab(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'move-tab' }>,
	activate: boolean,
): WorkspaceLayoutSnapshot {
	if (!windowNodeById(snapshot.desktopRoot, mutation.destinationWindowId)) {
		throw new Error(`Workspace window does not exist: ${mutation.destinationWindowId}`);
	}
	const sourceWindowId = windowIdOfSurface(snapshot.desktopRoot, mutation.surfaceId);
	const surface = snapshot.surfaces[mutation.surfaceId];
	if (!surface) throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
	if (surface.type === 'chat' && sourceWindowId !== mutation.destinationWindowId) {
		throw new Error('A window Chat view cannot move between windows');
	}
	if (sourceWindowId === mutation.destinationWindowId) {
		return {
			...snapshot,
			desktopRoot: mapWindows(snapshot.desktopRoot, (workspaceWindow) => {
				if (workspaceWindow.id !== mutation.destinationWindowId) return workspaceWindow;
				const tabs = insertTab(workspaceWindow.tabs, mutation.surfaceId, mutation.index);
				return {
					...workspaceWindow,
					tabs: activate ? activateTab(tabs, mutation.surfaceId) : tabs,
				};
			}),
		};
	}
	const next = removeEveryPlacement(snapshot, mutation.surfaceId);
	if (!windowNodeById(next.desktopRoot, mutation.destinationWindowId)) {
		throw new Error(
			`Destination window closed while moving a tab: ${mutation.destinationWindowId}`,
		);
	}
	return {
		...next,
		desktopRoot: mapWindows(next.desktopRoot, (workspaceWindow) => {
			if (workspaceWindow.id !== mutation.destinationWindowId) return workspaceWindow;
			const tabs = insertTab(workspaceWindow.tabs, mutation.surfaceId, mutation.index);
			return { ...workspaceWindow, tabs: activate ? activateTab(tabs, mutation.surfaceId) : tabs };
		}),
		fullscreenWindowId: fullscreenAfterActivation(next, mutation.destinationWindowId),
	};
}

function moveChatToWindow(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'move-chat-to-window' }>,
): WorkspaceLayoutSnapshot {
	if (mutation.sourceWindowId === mutation.destinationWindowId) {
		throw new Error('A Chat view must move to a different workspace window');
	}
	if (!windowNodeById(snapshot.desktopRoot, mutation.destinationWindowId)) {
		throw new Error(`Workspace window does not exist: ${mutation.destinationWindowId}`);
	}
	const source = movableWindowChat(snapshot, mutation.sourceWindowId);
	const destinationSurfaceId = chatViewSurfaceId(mutation.destinationWindowId);
	const removed = removeEveryPlacement(snapshot, source.surfaceId);
	if (!windowNodeById(removed.desktopRoot, mutation.destinationWindowId)) {
		throw new Error(`Destination window closed while moving Chat: ${mutation.destinationWindowId}`);
	}
	const surfaces = { ...removed.surfaces };
	delete surfaces[source.surfaceId];
	const rekeyed = rekeyChatSurfaceReferences(
		{ ...removed, surfaces },
		source.surfaceId,
		destinationSurfaceId,
	);
	const moved = setWindowChat(rekeyed, mutation.destinationWindowId, source.chatId, mutation.index);
	return {
		...moved,
		fullscreenWindowId: fullscreenAfterActivation(moved, mutation.destinationWindowId),
	};
}

function moveTabToNewWindow(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'move-tab-to-new-window' }>,
): WorkspaceLayoutSnapshot {
	const surface = snapshot.surfaces[mutation.surfaceId];
	if (!surface) throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
	if (!windowNodeById(snapshot.desktopRoot, mutation.targetWindowId)) {
		throw new Error(`Workspace window does not exist: ${mutation.targetWindowId}`);
	}
	const sourceWindowId = windowIdOfSurface(snapshot.desktopRoot, mutation.surfaceId);
	if (!sourceWindowId)
		throw new Error(`Surface is not in a workspace window: ${mutation.surfaceId}`);
	const sourceTabs = windowNodeById(snapshot.desktopRoot, sourceWindowId)?.tabs;
	if (sourceWindowId === mutation.targetWindowId && sourceTabs?.order.length === 1) return snapshot;
	if (surface.type === 'chat' && !surface.chatId) {
		throw new Error(`Workspace Chat view is empty: ${sourceWindowId}`);
	}
	if (
		projectedWindowCountAfterTabMove(
			snapshot.desktopRoot,
			sourceWindowId,
			mutation.targetWindowId,
		) > MAX_WORKSPACE_WINDOWS
	) {
		throw new Error('Workspace window count limit reached');
	}
	const next = removeEveryPlacement(snapshot, mutation.surfaceId);
	if (!windowNodeById(next.desktopRoot, mutation.targetWindowId)) {
		throw new Error(`Target window closed while moving a tab: ${mutation.targetWindowId}`);
	}
	if (windowNodeById(next.desktopRoot, mutation.newWindowId)) {
		throw new Error(`Workspace window already exists: ${mutation.newWindowId}`);
	}
	let moved = next;
	let destinationSurfaceId = mutation.surfaceId;
	if (surface.type === 'chat') {
		const newChatSurfaceId = chatViewSurfaceId(mutation.newWindowId);
		destinationSurfaceId = newChatSurfaceId;
		if (next.surfaces[newChatSurfaceId]) {
			throw new Error(`Surface already exists: ${newChatSurfaceId}`);
		}
		const surfaces: Record<string, SurfaceDescriptor> = { ...next.surfaces };
		delete surfaces[mutation.surfaceId];
		surfaces[newChatSurfaceId] = {
			id: newChatSurfaceId,
			type: 'chat',
			chatId: surface.chatId,
		};
		moved = rekeyChatSurfaceReferences(
			{ ...next, surfaces },
			mutation.surfaceId,
			destinationSurfaceId,
		);
	}
	return {
		...moved,
		desktopRoot: insertWindowAtEdge(
			moved.desktopRoot,
			mutation.targetWindowId,
			mutation.edge,
			singleTabWindow(mutation.newWindowId, destinationSurfaceId),
			mutation.partitionId,
		),
		fullscreenWindowId: null,
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
		unplacedTerminalIds: unique(unplacedTerminalIds),
	};
}

function closeWindow(
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

function normalizeFullscreenWindow(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
	if (!snapshot.fullscreenWindowId) return snapshot;
	if (!windowNodeById(snapshot.desktopRoot, snapshot.fullscreenWindowId)) {
		return { ...snapshot, fullscreenWindowId: null };
	}
	return snapshot;
}

function fullscreenAfterActivation(
	snapshot: WorkspaceLayoutSnapshot,
	windowId: WorkspaceWindowId,
): WorkspaceWindowId | null {
	return snapshot.fullscreenWindowId === windowId ? windowId : null;
}

function defaultActiveId(snapshot: WorkspaceLayoutSnapshot): string {
	const first = collectWindowNodes(snapshot.desktopRoot)[0];
	if (!first) throw new Error('Workspace has no windows');
	return first.tabs.activeId;
}

function applyMutation(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: WorkspaceLayoutMutation,
): WorkspaceLayoutSnapshot {
	switch (mutation.type) {
		case 'register-surface':
			return registerSurface(snapshot, mutation);
		case 'register-surface-in-new-window':
			return registerSurfaceInNewWindow(snapshot, mutation);
		case 'open-chat-in-new-window':
			return openChatInNewWindow(snapshot, mutation);
		case 'set-window-chat':
			return setWindowChat(snapshot, mutation.windowId, mutation.chatId);
		case 'replace-surface':
			return replaceSurface(snapshot, mutation);
		case 'swap-terminal-placements':
			return swapTerminalPlacements(snapshot, mutation);
		case 'activate-window-tab': {
			const workspaceWindow = windowNodeById(snapshot.desktopRoot, mutation.windowId);
			if (!workspaceWindow) {
				throw new Error(`Workspace window does not exist: ${mutation.windowId}`);
			}
			if (!workspaceWindow.tabs.order.includes(mutation.surfaceId)) {
				throw new Error(
					`Surface is not in workspace window ${mutation.windowId}: ${mutation.surfaceId}`,
				);
			}
			return {
				...snapshot,
				desktopRoot: mapWindows(snapshot.desktopRoot, (candidate) =>
					candidate.id === mutation.windowId
						? { ...candidate, tabs: activateTab(candidate.tabs, mutation.surfaceId) }
						: candidate,
				),
				fullscreenWindowId: fullscreenAfterActivation(snapshot, mutation.windowId),
			};
		}
		case 'move-tab':
			return moveTab(snapshot, mutation, true);
		case 'move-chat-to-window':
			return moveChatToWindow(snapshot, mutation);
		case 'assign-to-window':
			return moveTab(
				snapshot,
				{
					type: 'move-tab',
					surfaceId: mutation.surfaceId,
					destinationWindowId: mutation.destinationWindowId,
					index: mutation.index,
				},
				false,
			);
		case 'move-tab-to-new-window':
			return moveTabToNewWindow(snapshot, mutation);
		case 'close-window':
			return closeWindow(snapshot, mutation.windowId);
		case 'set-partition-ratio':
			return {
				...snapshot,
				desktopRoot: mapPartitions(snapshot.desktopRoot, (partition) =>
					partition.id === mutation.partitionId
						? { ...partition, ratio: clampPartitionRatio(mutation.ratio) }
						: partition,
				),
			};
		case 'set-fullscreen-window':
			if (mutation.windowId) {
				if (!windowNodeById(snapshot.desktopRoot, mutation.windowId)) {
					throw new Error(`Workspace window does not exist: ${mutation.windowId}`);
				}
			}
			return { ...snapshot, fullscreenWindowId: mutation.windowId };
		case 'place-in-dialog': {
			const surface = snapshot.surfaces[mutation.surfaceId];
			if (surface?.type !== 'file') throw new Error('Only file surfaces can enter dialog');
			if (snapshot.dialogFileSurfaceId && snapshot.dialogFileSurfaceId !== mutation.surfaceId) {
				throw new Error('Dialog capacity must be resolved before placement');
			}
			return normalizeFullscreenWindow({
				...removeEveryPlacement(snapshot, mutation.surfaceId),
				dialogFileSurfaceId: mutation.surfaceId,
			});
		}
		case 'move-dialog-to-window': {
			if (snapshot.dialogFileSurfaceId !== mutation.surfaceId) {
				throw new Error(`Surface is not in dialog: ${mutation.surfaceId}`);
			}
			return moveTab(
				{ ...snapshot, dialogFileSurfaceId: null },
				{
					type: 'move-tab',
					surfaceId: mutation.surfaceId,
					destinationWindowId: mutation.destinationWindowId,
					index: mutation.index,
				},
				true,
			);
		}
		case 'unplace-terminal':
			return updateTerminalPlacement(snapshot, mutation.terminalId, 'unplaced');
		case 'forget-terminal':
			return updateTerminalPlacement(snapshot, mutation.terminalId, 'forgotten');
		case 'remove-surface': {
			const surface = snapshot.surfaces[mutation.surfaceId];
			if (!surface) return snapshot;
			if (surface.type === 'chat' && workspaceChatViewCount(snapshot) <= 1) {
				throw new Error('At least one Chat view must remain');
			}
			const next = removeEveryPlacement(snapshot, mutation.surfaceId);
			const surfaces = { ...next.surfaces };
			delete surfaces[mutation.surfaceId];
			return normalizeFullscreenWindow({
				...next,
				surfaces,
				mobileActiveSurfaceId:
					next.mobileActiveSurfaceId === mutation.surfaceId
						? defaultActiveId(next)
						: next.mobileActiveSurfaceId,
				mobileReturnStack: next.mobileReturnStack.filter(
					(target) => target.invokerSurfaceId !== mutation.surfaceId,
				),
			});
		}
		case 'set-mobile-presentation':
			if (!snapshot.surfaces[mutation.activeId]) {
				throw new Error(`Unknown mobile surface: ${mutation.activeId}`);
			}
			return {
				...snapshot,
				mobileActiveSurfaceId: mutation.activeId,
				mobileReturnStack: normalizeReturnStack(mutation.returnStack),
			};
	}
}

export function reduceWorkspaceLayout(
	base: WorkspaceLayoutSnapshot,
	mutations: readonly WorkspaceLayoutMutation[],
): WorkspaceLayoutSnapshot {
	let next = base;
	for (const mutation of mutations) next = applyMutation(next, mutation);
	assertWorkspaceLayoutInvariants(next);
	return next;
}

export function assertWorkspaceLayoutInvariants(snapshot: WorkspaceLayoutSnapshot): void {
	const windows = collectWindowNodes(snapshot.desktopRoot);
	if (windows.length === 0) throw new Error('Workspace must contain a window');
	if (windows.length > MAX_WORKSPACE_WINDOWS) {
		throw new Error(`Workspace window count exceeds ${MAX_WORKSPACE_WINDOWS}`);
	}
	const windowIds = new Set<WorkspaceWindowId>();
	for (const workspaceWindow of windows) {
		if (!workspaceWindow.id.startsWith('window-')) {
			throw new Error(`Workspace window ID has an invalid prefix: ${workspaceWindow.id}`);
		}
		if (windowIds.has(workspaceWindow.id)) {
			throw new Error(`Workspace window ID is duplicated: ${workspaceWindow.id}`);
		}
		windowIds.add(workspaceWindow.id);
	}
	const partitionIds = new Set<string>();
	const collectPartitionIds = (node: DesktopWorkspaceNode): void => {
		if (node.type === 'window') return;
		if (!node.id.startsWith('partition-')) {
			throw new Error(`Workspace partition ID has an invalid prefix: ${node.id}`);
		}
		if (partitionIds.has(node.id)) {
			throw new Error(`Workspace partition ID is duplicated: ${node.id}`);
		}
		partitionIds.add(node.id);
		if (clampPartitionRatio(node.ratio) !== node.ratio) {
			throw new Error(`Workspace partition ratio is not canonical: ${node.id}`);
		}
		collectPartitionIds(node.children[0]);
		collectPartitionIds(node.children[1]);
	};
	collectPartitionIds(snapshot.desktopRoot);

	const buckets = new Map<string, number>();
	for (const workspaceWindow of windows) {
		if (workspaceWindow.tabs.order.length === 0) {
			throw new Error(`Workspace window is empty: ${workspaceWindow.id}`);
		}
		if (unique(workspaceWindow.tabs.order).length !== workspaceWindow.tabs.order.length) {
			throw new Error('Workspace window tab order is duplicated');
		}
		if (unique(workspaceWindow.tabs.mru).length !== workspaceWindow.tabs.mru.length) {
			throw new Error('Workspace window MRU is duplicated');
		}
		if (workspaceWindow.tabs.mru.some((id) => !workspaceWindow.tabs.order.includes(id))) {
			throw new Error('Workspace window MRU is stale');
		}
		if (workspaceWindow.tabs.order.some((id) => !workspaceWindow.tabs.mru.includes(id))) {
			throw new Error('Workspace window MRU is incomplete');
		}
		if (!workspaceWindow.tabs.order.includes(workspaceWindow.tabs.activeId)) {
			throw new Error(`Workspace window active surface must be present: ${workspaceWindow.id}`);
		}
		const chatSurfaceIds = workspaceWindow.tabs.order.filter(
			(id) => snapshot.surfaces[id]?.type === 'chat',
		);
		if (chatSurfaceIds.length > 1) {
			throw new Error(`Workspace window contains more than one Chat view: ${workspaceWindow.id}`);
		}
		if (chatSurfaceIds[0] && chatSurfaceIds[0] !== chatViewSurfaceId(workspaceWindow.id)) {
			throw new Error(
				`Chat view identity does not match its workspace window: ${workspaceWindow.id}`,
			);
		}
		for (const id of workspaceWindow.tabs.order) {
			buckets.set(id, (buckets.get(id) ?? 0) + 1);
		}
	}
	if (snapshot.dialogFileSurfaceId) {
		const dialogSurface = snapshot.surfaces[snapshot.dialogFileSurfaceId];
		if (dialogSurface?.type !== 'file') throw new Error('Dialog must reference a file surface');
		buckets.set(snapshot.dialogFileSurfaceId, (buckets.get(snapshot.dialogFileSurfaceId) ?? 0) + 1);
	}
	for (const id of snapshot.mobileOnlySurfaceIds) {
		const surface = snapshot.surfaces[id];
		if (!surface || (surface.type !== 'file' && !isPortableSingleton(surface))) {
			throw new Error(`Invalid mobile-only surface: ${id}`);
		}
		buckets.set(id, (buckets.get(id) ?? 0) + 1);
	}
	for (const [id, surface] of Object.entries(snapshot.surfaces)) {
		if (surface.id !== id) throw new Error(`Surface key mismatch: ${id}`);
		if (surface.type === 'chat') {
			if (snapshot.dialogFileSurfaceId === id || snapshot.mobileOnlySurfaceIds.includes(id)) {
				throw new Error(`Chat view has an invalid presentation bucket: ${id}`);
			}
			const owner = windowIdOfSurface(snapshot.desktopRoot, id);
			if (!owner || id !== chatViewSurfaceId(owner)) {
				throw new Error(`Chat view is not anchored to its workspace window: ${id}`);
			}
		}
		if (buckets.get(id) !== 1) throw new Error(`Surface must have one ownership bucket: ${id}`);
	}
	for (const id of buckets.keys()) {
		if (!snapshot.surfaces[id]) throw new Error(`Placement references missing surface: ${id}`);
	}
	if (workspaceChatViewCount(snapshot) === 0) {
		throw new Error('At least one Chat view must remain');
	}
	if (snapshot.fullscreenWindowId) {
		if (!windowIds.has(snapshot.fullscreenWindowId)) {
			throw new Error('Fullscreen must reference an existing workspace window');
		}
	}
	if (!snapshot.surfaces[snapshot.mobileActiveSurfaceId]) {
		throw new Error('Mobile active surface must exist');
	}
	if (snapshot.mobileReturnStack.length > MAX_MOBILE_RETURN_TARGETS) {
		throw new Error('Mobile return stack exceeds its cap');
	}
	if (
		unique(snapshot.unplacedTerminalIds).length !== snapshot.unplacedTerminalIds.length ||
		snapshot.unplacedTerminalIds.some((terminalId) => !terminalId)
	) {
		throw new Error('Unplaced terminal IDs must be unique and non-empty');
	}
	for (const terminalId of snapshot.unplacedTerminalIds) {
		if (snapshot.surfaces[terminalSurfaceId(terminalId)]) {
			throw new Error(`Terminal cannot be both placed and unplaced: ${terminalId}`);
		}
	}
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

export class WorkspaceLayoutStore implements WorkspaceLayoutReader, WorkspaceLayoutCommitPort {
	#revision = $state(0);
	#snapshot = $state.raw<WorkspaceLayoutSnapshot>(
		import.meta.env.DEV ? deepFreeze(canonicalWorkspaceSnapshot()) : canonicalWorkspaceSnapshot(),
	);

	constructor(initial: WorkspaceLayoutSnapshot = canonicalWorkspaceSnapshot()) {
		assertWorkspaceLayoutInvariants(initial);
		this.#snapshot = import.meta.env.DEV ? deepFreeze(initial) : initial;
	}

	get revision(): number {
		return this.#revision;
	}

	get snapshot(): WorkspaceLayoutSnapshot {
		return this.#snapshot;
	}

	get defaultWindowId(): WorkspaceWindowId {
		const first = collectWindowNodes(this.#snapshot.desktopRoot)[0];
		if (!first) throw new Error('Workspace has no windows');
		return first.id;
	}

	get defaultActiveId(): string {
		return defaultActiveId(this.#snapshot);
	}

	surface(surfaceId: string): SurfaceDescriptor | null {
		return this.#snapshot.surfaces[surfaceId] ?? null;
	}

	publish(expectedRevision: number, next: WorkspaceLayoutSnapshot): boolean {
		if (expectedRevision !== this.#revision) return false;
		assertWorkspaceLayoutInvariants(next);
		this.#snapshot = import.meta.env.DEV ? deepFreeze(next) : next;
		this.#revision += 1;
		return true;
	}
}

export function createWorkspaceLayoutStore(
	initial?: WorkspaceLayoutSnapshot,
): WorkspaceLayoutStore {
	return new WorkspaceLayoutStore(initial);
}
