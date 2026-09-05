import type {
	PersistedWorkspaceLayoutNode,
	PersistedWorkspaceLayoutV2,
	PersistedWorkspaceSurfaceRef,
} from '$shared/workspace-layout';
import { isRecord } from '$shared/json';
import {
	WORKSPACE_WINDOW_RESOURCE_CEILING,
	chatViewSurfaceId,
	portableSingletonDescriptor,
	terminalSurfaceId,
	type DesktopWorkspaceNode,
	type PortableSingletonKind,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	type WorkspacePartitionId,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
} from './surface-types.js';
import { assertWorkspaceLayoutInvariants } from './workspace-layout.svelte.js';
import { canonicalWorkspaceSnapshot } from './canonical-layout.js';
import {
	clampPartitionRatio,
	collectWindowNodes,
	mapWindows,
	removeWindowAndCollapse,
} from './window-tree.js';

export type WorkspaceLayoutRestoreSource = 'absent' | 'valid' | 'fallback';

export interface WorkspaceLayoutParseResult {
	source: WorkspaceLayoutRestoreSource;
	snapshot: WorkspaceLayoutSnapshot;
}

export const WORKSPACE_LAYOUT_MAX_PARSE_DEPTH = 64;
export const WORKSPACE_LAYOUT_MAX_PARSE_NODES = 256;
export const WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW = 256;
export const WORKSPACE_LAYOUT_MAX_UNPLACED_TERMINALS = 256;

class WorkspaceLayoutBudgetExceeded extends Error {}

const PORTABLE_SINGLETON_REF_KINDS = new Set<PortableSingletonKind>([
	'git',
	'git-history',
	'git-compare',
	'pull-requests',
	'files',
	'commit',
	'chat-map',
]);

function parseV2Ref(value: unknown): PersistedWorkspaceSurfaceRef | null {
	if (!isRecord(value)) return null;
	if (value.type === 'chat' && (value.chatId === null || typeof value.chatId === 'string')) {
		return { type: 'chat', chatId: value.chatId };
	}
	if (
		value.type === 'singleton' &&
		typeof value.kind === 'string' &&
		PORTABLE_SINGLETON_REF_KINDS.has(value.kind as PortableSingletonKind)
	) {
		return { type: 'singleton', kind: value.kind as PortableSingletonKind };
	}
	if (value.type === 'terminal' && typeof value.terminalId === 'string' && value.terminalId) {
		return { type: 'terminal', terminalId: value.terminalId };
	}
	return null;
}

function globalRefKey(ref: Exclude<PersistedWorkspaceSurfaceRef, { type: 'chat' }>): string {
	return ref.type === 'singleton' ? `singleton:${ref.kind}` : terminalSurfaceId(ref.terminalId);
}

function descriptorForGlobalRef(
	ref: Exclude<PersistedWorkspaceSurfaceRef, { type: 'chat' }>,
): SurfaceDescriptor {
	if (ref.type === 'terminal') {
		return { id: terminalSurfaceId(ref.terminalId), type: 'terminal', terminalId: ref.terminalId };
	}
	return portableSingletonDescriptor(ref.kind);
}

function asWindowId(id: unknown): WorkspaceWindowId | null {
	return typeof id === 'string' && id.startsWith('window-') ? (id as WorkspaceWindowId) : null;
}

function asPartitionId(id: unknown): WorkspacePartitionId | null {
	return typeof id === 'string' && id.startsWith('partition-')
		? (id as WorkspacePartitionId)
		: null;
}

interface TreeBuildState {
	surfaces: Record<string, SurfaceDescriptor>;
	seenGlobalSurfaceIds: Set<string>;
	visitedNodes: number;
}

function restoredRefSurfaceId(
	ref: PersistedWorkspaceSurfaceRef,
	windowId: WorkspaceWindowId,
): string {
	return ref.type === 'chat' ? chatViewSurfaceId(windowId) : globalRefKey(ref);
}

function restoreWindow(
	node: Record<string, unknown>,
	state: TreeBuildState,
): WorkspaceWindowNode | null {
	const id = asWindowId(node.id);
	if (!id || !Array.isArray(node.order)) return null;
	const orderRefs = node.order.slice(0, WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW);
	const order: string[] = [];
	let chatPlaced = false;
	for (const rawRef of orderRefs) {
		const ref = parseV2Ref(rawRef);
		if (!ref) continue;
		if (ref.type === 'chat') {
			if (chatPlaced) continue;
			chatPlaced = true;
			const surfaceId = chatViewSurfaceId(id);
			state.surfaces[surfaceId] = { id: surfaceId, type: 'chat', chatId: ref.chatId };
			order.push(surfaceId);
			continue;
		}
		const surfaceId = globalRefKey(ref);
		if (state.seenGlobalSurfaceIds.has(surfaceId)) continue;
		state.seenGlobalSurfaceIds.add(surfaceId);
		state.surfaces[surfaceId] = descriptorForGlobalRef(ref);
		order.push(surfaceId);
	}
	if (order.length === 0) return null;
	const orderSet = new Set(order);
	const activeRef = parseV2Ref(node.active);
	const activeKey = activeRef ? restoredRefSurfaceId(activeRef, id) : null;
	const activeId = activeKey && orderSet.has(activeKey) ? activeKey : order[0];
	const persistedMru: string[] = [];
	const persistedMruSet = new Set<string>();
	if (Array.isArray(node.mru)) {
		for (const rawRef of node.mru.slice(0, WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW)) {
			const ref = parseV2Ref(rawRef);
			if (!ref) continue;
			const surfaceId = restoredRefSurfaceId(ref, id);
			if (!orderSet.has(surfaceId) || persistedMruSet.has(surfaceId)) continue;
			persistedMru.push(surfaceId);
			persistedMruSet.add(surfaceId);
		}
	}
	const mru = [
		activeId,
		...persistedMru.filter((surfaceId) => surfaceId !== activeId),
		...order.filter((surfaceId) => surfaceId !== activeId && !persistedMruSet.has(surfaceId)),
	];
	return { type: 'window', id, tabs: { order, activeId, mru } };
}

function restoreNode(node: unknown, state: TreeBuildState, depth = 1): DesktopWorkspaceNode | null {
	state.visitedNodes += 1;
	if (
		depth > WORKSPACE_LAYOUT_MAX_PARSE_DEPTH ||
		state.visitedNodes > WORKSPACE_LAYOUT_MAX_PARSE_NODES
	) {
		throw new WorkspaceLayoutBudgetExceeded();
	}
	if (!isRecord(node)) return null;
	if (node.type === 'window') return restoreWindow(node, state);
	if (node.type !== 'partition') return null;
	const id = asPartitionId(node.id);
	if (!id || !Array.isArray(node.children) || node.children.length !== 2) return null;
	const first = restoreNode(node.children[0], state, depth + 1);
	const second = restoreNode(node.children[1], state, depth + 1);
	if (!first) return second;
	if (!second) return first;
	if (node.direction !== 'horizontal' && node.direction !== 'vertical') return null;
	return {
		type: 'partition',
		id,
		direction: node.direction,
		ratio: clampPartitionRatio(typeof node.ratio === 'number' ? node.ratio : 0.5),
		children: [first, second],
	};
}

function appendTabsToWindow(
	root: DesktopWorkspaceNode,
	windowId: WorkspaceWindowId,
	tabIds: readonly string[],
): DesktopWorkspaceNode {
	return mapWindows(root, (workspaceWindow) => {
		if (workspaceWindow.id !== windowId || tabIds.length === 0) return workspaceWindow;
		const order = [...workspaceWindow.tabs.order, ...tabIds];
		return {
			...workspaceWindow,
			tabs: {
				order,
				activeId: workspaceWindow.tabs.activeId,
				mru: [...workspaceWindow.tabs.mru, ...tabIds],
			},
		};
	});
}

function enforceWindowResourceCeiling(root: DesktopWorkspaceNode): DesktopWorkspaceNode {
	let next = root;
	while (collectWindowNodes(next).length > WORKSPACE_WINDOW_RESOURCE_CEILING) {
		const windows = collectWindowNodes(next);
		const overflow = windows[windows.length - 1];
		const collapsed = removeWindowAndCollapse(next, overflow.id);
		if (!collapsed) break;
		const first = collectWindowNodes(collapsed)[0];
		const movable = overflow.tabs.order.filter((surfaceId) => !surfaceId.startsWith('chat-view:'));
		next = appendTabsToWindow(collapsed, first.id, movable);
	}
	return next;
}

function pruneUnplacedDescriptors(root: DesktopWorkspaceNode, state: TreeBuildState): void {
	const placed = new Set(
		collectWindowNodes(root).flatMap((workspaceWindow) => workspaceWindow.tabs.order),
	);
	for (const surfaceId of Object.keys(state.surfaces)) {
		if (!placed.has(surfaceId)) delete state.surfaces[surfaceId];
	}
}

function parseUnplacedTerminalIds(
	value: unknown,
	surfaces: Readonly<Record<string, SurfaceDescriptor>>,
): string[] {
	if (!Array.isArray(value)) return [];
	const terminalIds = new Set<string>();
	for (const terminalId of value.slice(0, WORKSPACE_LAYOUT_MAX_UNPLACED_TERMINALS)) {
		if (
			typeof terminalId === 'string' &&
			terminalId.length > 0 &&
			!surfaces[terminalSurfaceId(terminalId)]
		) {
			terminalIds.add(terminalId);
		}
	}
	return [...terminalIds];
}

function parseV2(value: Record<string, unknown>): WorkspaceLayoutParseResult {
	const state: TreeBuildState = {
		surfaces: {},
		seenGlobalSurfaceIds: new Set(),
		visitedNodes: 0,
	};
	const restored = restoreNode(value.root, state);
	if (!restored) return { source: 'fallback', snapshot: canonicalWorkspaceSnapshot() };
	const root = enforceWindowResourceCeiling(restored);
	pruneUnplacedDescriptors(root, state);
	const firstWindow = collectWindowNodes(root)[0];
	if (!firstWindow) return { source: 'fallback', snapshot: canonicalWorkspaceSnapshot() };
	const snapshot: WorkspaceLayoutSnapshot = {
		desktopRoot: root,
		surfaces: state.surfaces,
		fullscreenWindowId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: firstWindow.tabs.activeId,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: parseUnplacedTerminalIds(value.unplacedTerminalIds, state.surfaces),
	};
	assertWorkspaceLayoutInvariants(snapshot);
	return { source: 'valid', snapshot };
}

export function parsePersistedWorkspaceLayout(rawV2: string | null): WorkspaceLayoutParseResult {
	if (rawV2 === null) {
		return { source: 'absent', snapshot: canonicalWorkspaceSnapshot() };
	}
	try {
		const value: unknown = JSON.parse(rawV2);
		if (!isRecord(value) || value.version !== 2) throw new Error('Unsupported layout version');
		return parseV2(value);
	} catch {
		return { source: 'fallback', snapshot: canonicalWorkspaceSnapshot() };
	}
}

function persistedRef(surface: SurfaceDescriptor): PersistedWorkspaceSurfaceRef | null {
	if (surface.type === 'chat') return { type: 'chat', chatId: surface.chatId };
	if (surface.type === 'terminal') return { type: 'terminal', terminalId: surface.terminalId };
	if (surface.type === 'singleton') return { type: 'singleton', kind: surface.kind };
	return null;
}

function serializeNode(
	node: DesktopWorkspaceNode,
	surfaces: Readonly<Record<string, SurfaceDescriptor>>,
): PersistedWorkspaceLayoutNode {
	if (node.type === 'window') {
		const order = node.tabs.order.flatMap((surfaceId) => {
			const ref = surfaces[surfaceId] ? persistedRef(surfaces[surfaceId]) : null;
			return ref ? [ref] : [];
		});
		const activeSurface = surfaces[node.tabs.activeId];
		const mru = node.tabs.mru.flatMap((surfaceId) => {
			const ref = surfaces[surfaceId] ? persistedRef(surfaces[surfaceId]) : null;
			return ref ? [ref] : [];
		});
		return {
			type: 'window',
			id: node.id,
			order,
			active: activeSurface ? persistedRef(activeSurface) : null,
			mru,
		};
	}
	return {
		type: 'partition',
		id: node.id,
		direction: node.direction,
		ratio: node.ratio,
		children: [
			serializeNode(node.children[0], surfaces),
			serializeNode(node.children[1], surfaces),
		],
	};
}

export function serializeWorkspaceLayout(
	snapshot: WorkspaceLayoutSnapshot,
): PersistedWorkspaceLayoutV2 {
	return {
		version: 2,
		root: serializeNode(snapshot.desktopRoot, snapshot.surfaces),
		unplacedTerminalIds: [...snapshot.unplacedTerminalIds],
	};
}
