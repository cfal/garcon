import type {
	PersistedWorkspaceHost,
	PersistedWorkspaceLayoutNode,
	PersistedWorkspaceLayoutV1,
	PersistedWorkspaceLayoutV2,
	PersistedWorkspaceSurfaceRef,
} from '$shared/workspace-layout';
import {
	CHAT_SURFACE_ID,
	MAX_WORKSPACE_PANES,
	type DesktopLayoutNode,
	type PaneId,
	type PaneNode,
	type SplitId,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	portableSingletonDescriptor,
	terminalSurfaceId,
} from './surface-types.js';
import { assertWorkspaceLayoutInvariants } from './workspace-layout.svelte.js';
import { canonicalWorkspaceSnapshot } from './canonical-layout.js';
import { clampSplitRatio, collectPaneNodes, removePaneAndCollapse } from './pane-tree.js';
import { isRecord } from '$shared/json';

export type WorkspaceLayoutRestoreSource = 'absent' | 'valid' | 'migrated' | 'fallback';

export interface WorkspaceLayoutParseResult {
	source: WorkspaceLayoutRestoreSource;
	snapshot: WorkspaceLayoutSnapshot;
}

const SINGLETON_REF_KINDS = new Set([
	'chat',
	'git',
	'git-history',
	'git-compare',
	'pull-requests',
	'files',
	'commit',
]);

function parseRef(value: unknown): PersistedWorkspaceSurfaceRef | null {
	if (!isRecord(value)) return null;
	if (value.type === 'singleton' && SINGLETON_REF_KINDS.has(String(value.kind))) {
		return { type: 'singleton', kind: value.kind as 'chat' };
	}
	if (value.type === 'terminal' && typeof value.terminalId === 'string' && value.terminalId) {
		return { type: 'terminal', terminalId: value.terminalId };
	}
	return null;
}

function refKey(ref: PersistedWorkspaceSurfaceRef): string {
	return ref.type === 'singleton'
		? singletonSurfaceIdForRef(ref.kind)
		: terminalSurfaceId(ref.terminalId);
}

function singletonSurfaceIdForRef(kind: string): string {
	return `singleton:${kind}`;
}

function descriptorFor(ref: PersistedWorkspaceSurfaceRef): SurfaceDescriptor {
	if (ref.type === 'terminal') {
		return { id: terminalSurfaceId(ref.terminalId), type: 'terminal', terminalId: ref.terminalId };
	}
	if (ref.kind === 'chat') return { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' };
	return portableSingletonDescriptor(ref.kind);
}

function asPaneId(id: unknown): PaneId | null {
	return typeof id === 'string' && id.startsWith('pane-') ? (id as PaneId) : null;
}

function asSplitId(id: unknown): SplitId | null {
	return typeof id === 'string' && id.startsWith('split-') ? (id as SplitId) : null;
}

interface TreeBuildState {
	surfaces: Record<string, SurfaceDescriptor>;
	seen: Set<string>;
	chatPlaced: boolean;
}

function restoreNode(node: unknown, state: TreeBuildState): DesktopLayoutNode | null {
	if (!isRecord(node)) return null;
	if (node.type === 'pane') {
		const id = asPaneId(node.id);
		if (!id || !Array.isArray(node.order)) return null;
		const order: string[] = [];
		for (const rawRef of node.order) {
			const ref = parseRef(rawRef);
			if (!ref) continue;
			const surfaceId = refKey(ref);
			if (state.seen.has(surfaceId)) continue;
			state.seen.add(surfaceId);
			if (surfaceId === CHAT_SURFACE_ID) state.chatPlaced = true;
			state.surfaces[surfaceId] = descriptorFor(ref);
			order.push(surfaceId);
		}
		if (order.length === 0) return null;
		const activeRef = parseRef(node.active);
		const activeKey = activeRef ? refKey(activeRef) : null;
		const activeId = activeKey && order.includes(activeKey) ? activeKey : order[0];
		const mru = activeId ? [activeId, ...order.filter((id) => id !== activeId)] : [];
		return { type: 'pane', id, tabs: { order, activeId, mru } };
	}
	if (node.type === 'split') {
		const id = asSplitId(node.id);
		if (!id || !Array.isArray(node.children) || node.children.length !== 2) return null;
		const first = restoreNode(node.children[0], state);
		const second = restoreNode(node.children[1], state);
		if (!first) return second;
		if (!second) return first;
		if (node.direction !== 'horizontal' && node.direction !== 'vertical') return null;
		return {
			type: 'split',
			id,
			direction: node.direction,
			ratio: clampSplitRatio(typeof node.ratio === 'number' ? node.ratio : 0.5),
			children: [first, second],
		};
	}
	return null;
}

// Collapses panes beyond the cap by moving their tabs into the first pane.
function enforcePaneCap(root: DesktopLayoutNode): DesktopLayoutNode {
	let next = root;
	while (collectPaneNodes(next).length > MAX_WORKSPACE_PANES) {
		const panes = collectPaneNodes(next);
		const overflow = panes[panes.length - 1];
		const collapsed = removePaneAndCollapse(next, overflow.id);
		if (!collapsed) break;
		const firstPaneId = collectPaneNodes(collapsed)[0].id;
		next = mapPaneTabs(collapsed, firstPaneId, (tabs) => ({
			...tabs,
			order: [...tabs.order, ...overflow.tabs.order],
			mru: [...tabs.mru, ...overflow.tabs.order],
		}));
	}
	return next;
}

function mapPaneTabs(
	node: DesktopLayoutNode,
	paneId: PaneId,
	map: (tabs: PaneNode['tabs']) => PaneNode['tabs'],
): DesktopLayoutNode {
	if (node.type === 'pane') {
		return node.id === paneId ? { ...node, tabs: map(node.tabs) } : node;
	}
	return {
		...node,
		children: [mapPaneTabs(node.children[0], paneId, map), mapPaneTabs(node.children[1], paneId, map)],
	};
}

function ensureChatPlaced(root: DesktopLayoutNode, state: TreeBuildState): DesktopLayoutNode {
	if (state.chatPlaced) return root;
	state.surfaces[CHAT_SURFACE_ID] = { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' };
	const firstPane = collectPaneNodes(root)[0];
	return mapPaneTabs(root, firstPane.id, (tabs) => ({
		order: [CHAT_SURFACE_ID, ...tabs.order],
		activeId: tabs.activeId ?? CHAT_SURFACE_ID,
		mru: [CHAT_SURFACE_ID, ...tabs.mru],
	}));
}

function parseV2(value: Record<string, unknown>): WorkspaceLayoutParseResult {
	const base = canonicalWorkspaceSnapshot();
	const state: TreeBuildState = { surfaces: {}, seen: new Set(), chatPlaced: false };
	const restored = restoreNode(value.root, state);
	if (!restored || collectPaneNodes(restored).length === 0) {
		return { source: 'fallback', snapshot: base };
	}
	let root = ensureChatPlaced(enforcePaneCap(restored), state);
	const unplacedTerminalIds = Array.isArray(value.unplacedTerminalIds)
		? [
				...new Set(
					value.unplacedTerminalIds.filter(
						(terminalId): terminalId is string =>
							typeof terminalId === 'string' &&
							Boolean(terminalId) &&
							!state.surfaces[terminalSurfaceId(terminalId)],
					),
				),
			]
		: [];
	const snapshot: WorkspaceLayoutSnapshot = {
		desktopRoot: root,
		surfaces: state.surfaces,
		fullscreenPaneId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds,
	};
	assertWorkspaceLayoutInvariants(snapshot);
	return { source: 'valid', snapshot };
}

function hostSurfaceIds(
	host: PersistedWorkspaceHost,
	state: TreeBuildState,
): { order: string[]; activeId: string | null } {
	const order: string[] = [];
	for (const rawRef of host.order) {
		const ref = parseRef(rawRef);
		if (!ref) continue;
		const surfaceId = refKey(ref);
		if (surfaceId === CHAT_SURFACE_ID || state.seen.has(surfaceId)) continue;
		state.seen.add(surfaceId);
		state.surfaces[surfaceId] = descriptorFor(ref);
		order.push(surfaceId);
	}
	const activeRef = parseRef(host.active);
	const activeKey = activeRef ? refKey(activeRef) : null;
	return { order, activeId: activeKey && order.includes(activeKey) ? activeKey : null };
}

function migrateV1(value: PersistedWorkspaceLayoutV1): WorkspaceLayoutParseResult {
	const state: TreeBuildState = { surfaces: {}, seen: new Set(), chatPlaced: true };
	state.surfaces[CHAT_SURFACE_ID] = { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' };
	const main = hostSurfaceIds(value.main, state);
	const sidebar = hostSurfaceIds(value.sidebar, state);
	const mainOrder = [CHAT_SURFACE_ID, ...main.order];
	const mainActive =
		main.activeId ?? (mainOrder.includes(CHAT_SURFACE_ID) ? CHAT_SURFACE_ID : mainOrder[0]);
	const mainPane: PaneNode = {
		type: 'pane',
		id: 'pane-main',
		tabs: {
			order: mainOrder,
			activeId: mainActive,
			mru: [mainActive, ...mainOrder.filter((id) => id !== mainActive)],
		},
	};
	let root: DesktopLayoutNode = mainPane;
	if (value.sidebarOpen && sidebar.order.length > 0) {
		const sidebarActive = sidebar.activeId ?? sidebar.order[0];
		const sidebarPane: PaneNode = {
			type: 'pane',
			id: 'pane-sidebar',
			tabs: {
				order: sidebar.order,
				activeId: sidebarActive,
				mru: [sidebarActive, ...sidebar.order.filter((id) => id !== sidebarActive)],
			},
		};
		const width = typeof value.desiredSidebarWidth === 'number' ? value.desiredSidebarWidth : 480;
		root = {
			type: 'split',
			id: 'split-root',
			direction: 'horizontal',
			ratio: clampSplitRatio(1 - width / 1440),
			children: [mainPane, sidebarPane],
		};
	} else if (sidebar.order.length > 0) {
		root = mapPaneTabs(mainPane, mainPane.id, (tabs) => ({
			order: [...tabs.order, ...sidebar.order],
			activeId: tabs.activeId,
			mru: [...tabs.mru, ...sidebar.order],
		}));
	}
	const unplacedTerminalIds = Array.isArray(value.unplacedTerminalIds)
		? [
				...new Set(
					value.unplacedTerminalIds.filter(
						(terminalId): terminalId is string =>
							typeof terminalId === 'string' &&
							Boolean(terminalId) &&
							!state.surfaces[terminalSurfaceId(terminalId)],
					),
				),
			]
		: [];
	const snapshot: WorkspaceLayoutSnapshot = {
		desktopRoot: root,
		surfaces: state.surfaces,
		fullscreenPaneId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: CHAT_SURFACE_ID,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds,
	};
	assertWorkspaceLayoutInvariants(snapshot);
	return { source: 'migrated', snapshot };
}

export function parsePersistedWorkspaceLayout(
	rawV2: string | null,
	rawV1: string | null = null,
): WorkspaceLayoutParseResult {
	if (rawV2 !== null) {
		try {
			const value: unknown = JSON.parse(rawV2);
			if (!isRecord(value) || value.version !== 2) throw new Error('Unsupported layout version');
			return parseV2(value);
		} catch {
			return { source: 'fallback', snapshot: canonicalWorkspaceSnapshot() };
		}
	}
	if (rawV1 !== null) {
		try {
			const value: unknown = JSON.parse(rawV1);
			if (!isRecord(value) || value.version !== 1) throw new Error('Unsupported layout version');
			return migrateV1(value as unknown as PersistedWorkspaceLayoutV1);
		} catch {
			return { source: 'fallback', snapshot: canonicalWorkspaceSnapshot() };
		}
	}
	return { source: 'absent', snapshot: canonicalWorkspaceSnapshot() };
}

function persistedRef(surface: SurfaceDescriptor): PersistedWorkspaceSurfaceRef | null {
	if (surface.type === 'terminal') return { type: 'terminal', terminalId: surface.terminalId };
	if (surface.type !== 'singleton') return null;
	return { type: 'singleton', kind: surface.kind };
}

function serializeNode(
	node: DesktopLayoutNode,
	surfaces: Readonly<Record<string, SurfaceDescriptor>>,
): PersistedWorkspaceLayoutNode {
	if (node.type === 'pane') {
		const order = node.tabs.order.flatMap((id) => {
			const ref = surfaces[id] ? persistedRef(surfaces[id]) : null;
			return ref ? [ref] : [];
		});
		const activeSurface = node.tabs.activeId ? surfaces[node.tabs.activeId] : null;
		return {
			type: 'pane',
			id: node.id,
			order,
			active: activeSurface ? persistedRef(activeSurface) : null,
		};
	}
	return {
		type: 'split',
		id: node.id,
		direction: node.direction,
		ratio: node.ratio,
		children: [serializeNode(node.children[0], surfaces), serializeNode(node.children[1], surfaces)],
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
