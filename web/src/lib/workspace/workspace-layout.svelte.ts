import {
	CHAT_SURFACE_ID,
	MAX_MOBILE_RETURN_TARGETS,
	MAX_WORKSPACE_PANES,
	type DesktopLayoutNode,
	type MobileReturnTarget,
	type PaneId,
	type PaneNode,
	type PaneTabState,
	type SurfaceDescriptor,
	type WorkspaceLayoutCommitPort,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutReader,
	type WorkspaceLayoutSnapshot,
	isPortableSingleton,
	terminalSurfaceId,
} from './surface-types.js';
import {
	clampSplitRatio,
	collectPaneNodes,
	insertPaneSplit,
	mapPanes,
	mapSplits,
	paneCount,
	paneIdOfSurface,
	paneNodeById,
	projectedPaneCountAfterTabSplit,
	removePaneAndCollapse,
} from './pane-tree.js';
import { canonicalWorkspaceSnapshot } from './canonical-layout.js';

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function tabsWithOrder(tabs: PaneTabState, order: readonly string[]): PaneTabState {
	const nextOrder = unique(order);
	const nextMru = unique(tabs.mru).filter((id) => nextOrder.includes(id));
	for (const id of nextOrder) {
		if (!nextMru.includes(id)) nextMru.push(id);
	}
	const activeId =
		tabs.activeId && nextOrder.includes(tabs.activeId)
			? tabs.activeId
			: (nextMru[0] ?? nextOrder[0] ?? null);
	return { order: nextOrder, activeId, mru: nextMru };
}

function activateTab(tabs: PaneTabState, surfaceId: string): PaneTabState {
	if (!tabs.order.includes(surfaceId)) throw new Error(`Surface is not in pane: ${surfaceId}`);
	return {
		order: [...tabs.order],
		activeId: surfaceId,
		mru: [surfaceId, ...tabs.mru.filter((id) => id !== surfaceId)],
	};
}

function insertTab(tabs: PaneTabState, surfaceId: string, index?: number): PaneTabState {
	const without = tabs.order.filter((id) => id !== surfaceId);
	const insertionIndex =
		index === undefined ? without.length : Math.max(0, Math.min(without.length, Math.trunc(index)));
	without.splice(insertionIndex, 0, surfaceId);
	return tabsWithOrder(tabs, without);
}

function removeTab(tabs: PaneTabState, surfaceId: string): PaneTabState {
	return tabsWithOrder(
		{ ...tabs, mru: tabs.mru.filter((id) => id !== surfaceId) },
		tabs.order.filter((id) => id !== surfaceId),
	);
}

function singleTabPane(paneId: PaneId, surfaceId: string): PaneNode {
	return {
		type: 'pane',
		id: paneId,
		tabs: { order: [surfaceId], activeId: surfaceId, mru: [surfaceId] },
	};
}

function normalizeReturnStack(stack: readonly MobileReturnTarget[]): MobileReturnTarget[] {
	const normalized: MobileReturnTarget[] = [];
	for (const target of stack) {
		if (!target || typeof target.invokerSurfaceId !== 'string' || !target.invokerSurfaceId)
			continue;
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

// Removes a surface from every pane and clears dialog/mobile-only ownership.
// Panes left empty are collapsed unless they are the root pane; the caller
// must guarantee the root pane never empties (chat is always present).
function removeEveryPlacement(
	snapshot: WorkspaceLayoutSnapshot,
	surfaceId: string,
): WorkspaceLayoutSnapshot {
	let root = mapPanes(snapshot.desktopRoot, (pane) =>
		pane.tabs.order.includes(surfaceId) ? { ...pane, tabs: removeTab(pane.tabs, surfaceId) } : pane,
	);
	let fullscreenPaneId = snapshot.fullscreenPaneId;
	for (const pane of collectPaneNodes(root)) {
		if (pane.tabs.order.length > 0) continue;
		const collapsed = removePaneAndCollapse(root, pane.id);
		if (!collapsed) throw new Error(`Cannot empty the root pane: ${pane.id}`);
		root = collapsed;
		if (fullscreenPaneId === pane.id) fullscreenPaneId = null;
	}
	return {
		...snapshot,
		desktopRoot: root,
		fullscreenPaneId,
		dialogFileSurfaceId:
			snapshot.dialogFileSurfaceId === surfaceId ? null : snapshot.dialogFileSurfaceId,
		mobileOnlySurfaceIds: snapshot.mobileOnlySurfaceIds.filter((id) => id !== surfaceId),
	};
}

function registerSurface(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'register-surface' }>,
): WorkspaceLayoutSnapshot {
	if (snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Surface already exists: ${mutation.surface.id}`);
	}
	if (
		!mutation.paneId &&
		mutation.surface.type !== 'file' &&
		!isPortableSingleton(mutation.surface)
	) {
		throw new Error('Only file and portable singleton surfaces may be mobile-only');
	}
	const placedTerminalId =
		mutation.surface.type === 'terminal' ? mutation.surface.terminalId : null;
	let next: WorkspaceLayoutSnapshot = {
		...snapshot,
		surfaces: { ...snapshot.surfaces, [mutation.surface.id]: mutation.surface },
		unplacedTerminalIds: placedTerminalId
			? snapshot.unplacedTerminalIds.filter((terminalId) => terminalId !== placedTerminalId)
			: snapshot.unplacedTerminalIds,
	};
	if (!mutation.paneId) {
		return {
			...next,
			mobileOnlySurfaceIds: [...next.mobileOnlySurfaceIds, mutation.surface.id],
		};
	}
	const pane = paneNodeById(next.desktopRoot, mutation.paneId);
	if (!pane) throw new Error(`Pane does not exist: ${mutation.paneId}`);
	const root = mapPanes(next.desktopRoot, (candidate) =>
		candidate.id === mutation.paneId
			? { ...candidate, tabs: insertTab(candidate.tabs, mutation.surface.id, mutation.index) }
			: candidate,
	);
	next = { ...next, desktopRoot: root };
	return next;
}

function registerSurfaceInSplit(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'register-surface-in-split' }>,
): WorkspaceLayoutSnapshot {
	if (snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Surface already exists: ${mutation.surface.id}`);
	}
	if (!paneNodeById(snapshot.desktopRoot, mutation.targetPaneId)) {
		throw new Error(`Pane does not exist: ${mutation.targetPaneId}`);
	}
	if (paneCount(snapshot.desktopRoot) >= MAX_WORKSPACE_PANES) {
		throw new Error('Pane count limit reached');
	}
	const placedTerminalId =
		mutation.surface.type === 'terminal' ? mutation.surface.terminalId : null;
	const root = insertPaneSplit(
		snapshot.desktopRoot,
		mutation.targetPaneId,
		mutation.edge,
		singleTabPane(mutation.newPaneId, mutation.surface.id),
		mutation.splitId,
	);
	return {
		...snapshot,
		desktopRoot: root,
		surfaces: { ...snapshot.surfaces, [mutation.surface.id]: mutation.surface },
		fullscreenPaneId: fullscreenAfterActivation(snapshot, mutation.newPaneId),
		unplacedTerminalIds: placedTerminalId
			? snapshot.unplacedTerminalIds.filter((terminalId) => terminalId !== placedTerminalId)
			: snapshot.unplacedTerminalIds,
	};
}

function replaceSurface(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'replace-surface' }>,
): WorkspaceLayoutSnapshot {
	if (!snapshot.surfaces[mutation.previousId]) {
		throw new Error(`Surface does not exist: ${mutation.previousId}`);
	}
	if (mutation.previousId !== mutation.surface.id && snapshot.surfaces[mutation.surface.id]) {
		throw new Error(`Replacement surface already exists: ${mutation.surface.id}`);
	}
	const replaceId = (ids: readonly string[]) =>
		ids.map((id) => (id === mutation.previousId ? mutation.surface.id : id));
	const replaceTabs = (tabs: PaneTabState): PaneTabState => ({
		order: replaceId(tabs.order),
		activeId:
			tabs.activeId === mutation.previousId ? mutation.surface.id : tabs.activeId,
		mru: replaceId(tabs.mru),
	});
	const surfaces = { ...snapshot.surfaces };
	const previous = surfaces[mutation.previousId];
	delete surfaces[mutation.previousId];
	surfaces[mutation.surface.id] = mutation.surface;
	let unplacedTerminalIds = [...snapshot.unplacedTerminalIds];
	if (
		previous?.type === 'terminal' &&
		(mutation.surface.type !== 'terminal' || previous.terminalId !== mutation.surface.terminalId)
	) {
		unplacedTerminalIds = unique([...unplacedTerminalIds, previous.terminalId]);
	}
	if (mutation.surface.type === 'terminal') {
		const placedTerminalId = mutation.surface.terminalId;
		unplacedTerminalIds = unplacedTerminalIds.filter(
			(terminalId) => terminalId !== placedTerminalId,
		);
	}
	return {
		...snapshot,
		desktopRoot: mapPanes(snapshot.desktopRoot, (pane) => ({ ...pane, tabs: replaceTabs(pane.tabs) })),
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
	return normalizeFullscreenPane({
		...next,
		surfaces,
		mobileActiveSurfaceId:
			next.mobileActiveSurfaceId === surfaceId
				? defaultActiveId(next)
				: next.mobileActiveSurfaceId,
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
	const swapTabs = (tabs: PaneTabState): PaneTabState => ({
		order: tabs.order.map(swapId),
		activeId: tabs.activeId ? swapId(tabs.activeId) : null,
		mru: tabs.mru.map(swapId),
	});
	return {
		...snapshot,
		desktopRoot: mapPanes(snapshot.desktopRoot, (pane) => ({ ...pane, tabs: swapTabs(pane.tabs) })),
		mobileActiveSurfaceId: swapId(snapshot.mobileActiveSurfaceId),
		mobileReturnStack: snapshot.mobileReturnStack.map((target) => ({
			...target,
			invokerSurfaceId: swapId(target.invokerSurfaceId),
		})),
	};
}

function moveTab(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'move-tab' }>,
): WorkspaceLayoutSnapshot {
	if (!snapshot.surfaces[mutation.surfaceId]) {
		throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
	}
	if (!paneNodeById(snapshot.desktopRoot, mutation.destinationPaneId)) {
		throw new Error(`Pane does not exist: ${mutation.destinationPaneId}`);
	}
	const sourcePaneId = paneIdOfSurface(snapshot.desktopRoot, mutation.surfaceId);
	let next = snapshot;
	if (sourcePaneId !== mutation.destinationPaneId) {
		next = removeEveryPlacement(next, mutation.surfaceId);
	}
	const root = mapPanes(next.desktopRoot, (pane) =>
		pane.id === mutation.destinationPaneId
			? {
					...pane,
					tabs: activateTab(
						insertTab(pane.tabs, mutation.surfaceId, mutation.index),
						mutation.surfaceId,
					),
				}
			: pane,
	);
	return {
		...next,
		desktopRoot: root,
		fullscreenPaneId: fullscreenAfterActivation(next, mutation.destinationPaneId),
	};
}

function splitTabToEdge(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'split-tab-to-edge' }>,
): WorkspaceLayoutSnapshot {
	if (!snapshot.surfaces[mutation.surfaceId]) {
		throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
	}
	if (!paneNodeById(snapshot.desktopRoot, mutation.targetPaneId)) {
		throw new Error(`Pane does not exist: ${mutation.targetPaneId}`);
	}
	const sourcePaneId = paneIdOfSurface(snapshot.desktopRoot, mutation.surfaceId);
	if (!sourcePaneId) throw new Error(`Surface is not in a pane: ${mutation.surfaceId}`);
	const sourceTabs = paneNodeById(snapshot.desktopRoot, sourcePaneId)?.tabs;
	if (sourcePaneId === mutation.targetPaneId && sourceTabs?.order.length === 1) {
		return snapshot;
	}
	if (
		projectedPaneCountAfterTabSplit(
			snapshot.desktopRoot,
			sourcePaneId,
			mutation.targetPaneId,
		) > MAX_WORKSPACE_PANES
	) {
		throw new Error('Pane count limit reached');
	}
	let next = removeEveryPlacement(snapshot, mutation.surfaceId);
	if (!paneNodeById(next.desktopRoot, mutation.targetPaneId)) {
		throw new Error(`Pane does not exist after collapsing the source pane: ${mutation.targetPaneId}`);
	}
	const root = insertPaneSplit(
		next.desktopRoot,
		mutation.targetPaneId,
		mutation.edge,
		singleTabPane(mutation.newPaneId, mutation.surfaceId),
		mutation.splitId,
	);
	next = {
		...next,
		desktopRoot: root,
		fullscreenPaneId: fullscreenAfterActivation(next, mutation.newPaneId),
	};
	return next;
}

function mergePane(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: Extract<WorkspaceLayoutMutation, { type: 'merge-pane' }>,
): WorkspaceLayoutSnapshot {
	if (mutation.sourcePaneId === mutation.destinationPaneId) {
		throw new Error('Cannot merge a pane into itself');
	}
	const source = paneNodeById(snapshot.desktopRoot, mutation.sourcePaneId);
	const destination = paneNodeById(snapshot.desktopRoot, mutation.destinationPaneId);
	if (!source) throw new Error(`Pane does not exist: ${mutation.sourcePaneId}`);
	if (!destination) throw new Error(`Pane does not exist: ${mutation.destinationPaneId}`);
	const collapsed = removePaneAndCollapse(snapshot.desktopRoot, mutation.sourcePaneId);
	if (!collapsed) throw new Error('Cannot merge away the root pane');
	const root = mapPanes(collapsed, (pane) => {
		if (pane.id !== mutation.destinationPaneId) return pane;
		let tabs = pane.tabs;
		for (const surfaceId of source.tabs.order) tabs = insertTab(tabs, surfaceId);
		return { ...pane, tabs };
	});
	return normalizeFullscreenPane({
		...snapshot,
		desktopRoot: root,
		fullscreenPaneId:
			snapshot.fullscreenPaneId === mutation.sourcePaneId ? null : snapshot.fullscreenPaneId,
	});
}

function normalizeFullscreenPane(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
	if (
		snapshot.fullscreenPaneId &&
		!paneNodeById(snapshot.desktopRoot, snapshot.fullscreenPaneId)
	) {
		return { ...snapshot, fullscreenPaneId: null };
	}
	return snapshot;
}

// Activating a tab makes its pane the visible fullscreen target: activating
// inside the fullscreened pane preserves fullscreen; activating elsewhere
// exits it so the newly active surface is actually visible.
function fullscreenAfterActivation(
	snapshot: WorkspaceLayoutSnapshot,
	paneId: PaneId,
): PaneId | null {
	return snapshot.fullscreenPaneId === paneId ? snapshot.fullscreenPaneId : null;
}

function defaultActiveId(snapshot: WorkspaceLayoutSnapshot): string {
	const chatPaneId = paneIdOfSurface(snapshot.desktopRoot, CHAT_SURFACE_ID);
	const chatPane = chatPaneId ? paneNodeById(snapshot.desktopRoot, chatPaneId) : null;
	return chatPane?.tabs.activeId ?? CHAT_SURFACE_ID;
}

function applyMutation(
	snapshot: WorkspaceLayoutSnapshot,
	mutation: WorkspaceLayoutMutation,
): WorkspaceLayoutSnapshot {
	switch (mutation.type) {
		case 'register-surface':
			return registerSurface(snapshot, mutation);
		case 'register-surface-in-split':
			return registerSurfaceInSplit(snapshot, mutation);
		case 'replace-surface':
			return replaceSurface(snapshot, mutation);
		case 'swap-terminal-placements':
			return swapTerminalPlacements(snapshot, mutation);
		case 'activate-pane-tab': {
			const pane = paneNodeById(snapshot.desktopRoot, mutation.paneId);
			if (!pane) throw new Error(`Pane does not exist: ${mutation.paneId}`);
			if (!pane.tabs.order.includes(mutation.surfaceId)) {
				throw new Error(`Surface is not in pane ${mutation.paneId}: ${mutation.surfaceId}`);
			}
			return {
				...snapshot,
				desktopRoot: mapPanes(snapshot.desktopRoot, (candidate) =>
					candidate.id === mutation.paneId
						? { ...candidate, tabs: activateTab(candidate.tabs, mutation.surfaceId) }
						: candidate,
				),
				fullscreenPaneId: fullscreenAfterActivation(snapshot, mutation.paneId),
			};
		}
		case 'move-tab':
			return moveTab(snapshot, mutation);
		case 'assign-to-pane': {
			if (!snapshot.surfaces[mutation.surfaceId]) {
				throw new Error(`Surface does not exist: ${mutation.surfaceId}`);
			}
			if (!paneNodeById(snapshot.desktopRoot, mutation.destinationPaneId)) {
				throw new Error(`Pane does not exist: ${mutation.destinationPaneId}`);
			}
			// Reordering within the owning pane must not collapse it.
			if (paneIdOfSurface(snapshot.desktopRoot, mutation.surfaceId) === mutation.destinationPaneId) {
				return {
					...snapshot,
					desktopRoot: mapPanes(snapshot.desktopRoot, (pane) =>
						pane.id === mutation.destinationPaneId
							? { ...pane, tabs: insertTab(pane.tabs, mutation.surfaceId, mutation.index) }
							: pane,
					),
				};
			}
			const next = removeEveryPlacement(snapshot, mutation.surfaceId);
			return {
				...next,
				desktopRoot: mapPanes(next.desktopRoot, (pane) =>
					pane.id === mutation.destinationPaneId
						? { ...pane, tabs: insertTab(pane.tabs, mutation.surfaceId, mutation.index) }
						: pane,
				),
			};
		}
		case 'split-tab-to-edge':
			return splitTabToEdge(snapshot, mutation);
		case 'merge-pane':
			return mergePane(snapshot, mutation);
		case 'set-split-ratio':
			return {
				...snapshot,
				desktopRoot: mapSplits(snapshot.desktopRoot, (split) =>
					split.id === mutation.splitId
						? { ...split, ratio: clampSplitRatio(mutation.ratio) }
						: split,
				),
			};
		case 'set-fullscreen-pane':
			if (mutation.paneId && !paneNodeById(snapshot.desktopRoot, mutation.paneId)) {
				throw new Error(`Pane does not exist: ${mutation.paneId}`);
			}
			return { ...snapshot, fullscreenPaneId: mutation.paneId };
		case 'place-in-dialog': {
			const surface = snapshot.surfaces[mutation.surfaceId];
			if (surface?.type !== 'file') throw new Error('Only file surfaces can enter dialog');
			if (snapshot.dialogFileSurfaceId && snapshot.dialogFileSurfaceId !== mutation.surfaceId) {
				throw new Error('Dialog capacity must be resolved before placement');
			}
			return normalizeFullscreenPane({
				...removeEveryPlacement(snapshot, mutation.surfaceId),
				dialogFileSurfaceId: mutation.surfaceId,
			});
		}
		case 'move-dialog-to-pane': {
			if (snapshot.dialogFileSurfaceId !== mutation.surfaceId) {
				throw new Error(`Surface is not in dialog: ${mutation.surfaceId}`);
			}
			return moveTab(
				{ ...snapshot, dialogFileSurfaceId: null },
				{
					type: 'move-tab',
					surfaceId: mutation.surfaceId,
					destinationPaneId: mutation.destinationPaneId,
					index: mutation.index,
				},
			);
		}
		case 'unplace-terminal':
			return updateTerminalPlacement(snapshot, mutation.terminalId, 'unplaced');
		case 'forget-terminal':
			return updateTerminalPlacement(snapshot, mutation.terminalId, 'forgotten');
		case 'remove-surface': {
			if (mutation.surfaceId === CHAT_SURFACE_ID) throw new Error('Chat cannot close');
			if (!snapshot.surfaces[mutation.surfaceId]) return snapshot;
			const next = removeEveryPlacement(snapshot, mutation.surfaceId);
			const surfaces = { ...next.surfaces };
			delete surfaces[mutation.surfaceId];
			return normalizeFullscreenPane({
				...next,
				surfaces,
				mobileActiveSurfaceId:
					next.mobileActiveSurfaceId === mutation.surfaceId
						? defaultActiveId(next)
						: next.mobileActiveSurfaceId,
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
	const panes = collectPaneNodes(snapshot.desktopRoot);
	const paneIds = new Set<PaneId>();
	for (const pane of panes) {
		if (paneIds.has(pane.id)) throw new Error(`Pane ID is duplicated: ${pane.id}`);
		paneIds.add(pane.id);
	}
	if (panes.length > MAX_WORKSPACE_PANES) {
		throw new Error(`Pane count exceeds ${MAX_WORKSPACE_PANES}`);
	}
	const splitIds = new Set<string>();
	const collectSplitIds = (node: DesktopLayoutNode): void => {
		if (node.type === 'pane') return;
		if (splitIds.has(node.id)) throw new Error(`Split ID is duplicated: ${node.id}`);
		splitIds.add(node.id);
		if (clampSplitRatio(node.ratio) !== node.ratio) {
			throw new Error(`Split ratio is not canonical: ${node.id}`);
		}
		collectSplitIds(node.children[0]);
		collectSplitIds(node.children[1]);
	};
	collectSplitIds(snapshot.desktopRoot);

	let chatCount = 0;
	const buckets = new Map<string, number>();
	for (const pane of panes) {
		if (pane.tabs.order.length === 0) throw new Error(`Pane is empty: ${pane.id}`);
		if (unique(pane.tabs.order).length !== pane.tabs.order.length) {
			throw new Error('Pane tab order is duplicated');
		}
		if (unique(pane.tabs.mru).length !== pane.tabs.mru.length) {
			throw new Error('Pane MRU is duplicated');
		}
		if (pane.tabs.mru.some((id) => !pane.tabs.order.includes(id))) {
			throw new Error('Pane MRU is stale');
		}
		if (pane.tabs.order.some((id) => !pane.tabs.mru.includes(id))) {
			throw new Error('Pane MRU is incomplete');
		}
		if (!pane.tabs.activeId || !pane.tabs.order.includes(pane.tabs.activeId)) {
			throw new Error(`Pane active surface must be present: ${pane.id}`);
		}
		for (const id of pane.tabs.order) {
			if (id === CHAT_SURFACE_ID) chatCount += 1;
			buckets.set(id, (buckets.get(id) ?? 0) + 1);
		}
	}
	if (chatCount !== 1) throw new Error('Chat must exist exactly once in the pane tree');
	if (snapshot.dialogFileSurfaceId === CHAT_SURFACE_ID) throw new Error('Chat cannot enter dialog');
	if (snapshot.dialogFileSurfaceId) {
		buckets.set(snapshot.dialogFileSurfaceId, (buckets.get(snapshot.dialogFileSurfaceId) ?? 0) + 1);
	}
	for (const id of snapshot.mobileOnlySurfaceIds) {
		buckets.set(id, (buckets.get(id) ?? 0) + 1);
		const surface = snapshot.surfaces[id];
		if (!surface || (surface.type !== 'file' && !isPortableSingleton(surface))) {
			throw new Error(`Invalid mobile-only surface: ${id}`);
		}
	}
	for (const [id, surface] of Object.entries(snapshot.surfaces)) {
		if (surface.id !== id) throw new Error(`Surface key mismatch: ${id}`);
		if (buckets.get(id) !== 1) throw new Error(`Surface must have one ownership bucket: ${id}`);
	}
	for (const id of buckets.keys()) {
		if (!snapshot.surfaces[id]) throw new Error(`Placement references missing surface: ${id}`);
	}
	if (
		snapshot.fullscreenPaneId &&
		!paneIds.has(snapshot.fullscreenPaneId)
	) {
		throw new Error('Fullscreen pane must exist');
	}
	if (snapshot.dialogFileSurfaceId) {
		if (snapshot.surfaces[snapshot.dialogFileSurfaceId]?.type !== 'file') {
			throw new Error('Dialog must reference a file surface');
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

	get chatPaneId(): PaneId {
		const paneId = paneIdOfSurface(this.#snapshot.desktopRoot, CHAT_SURFACE_ID);
		if (!paneId) throw new Error('Chat pane is missing from the layout');
		return paneId;
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
