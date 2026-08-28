import { describe, expect, it } from 'vitest';
import {
	WorkspaceLayoutStore,
	assertWorkspaceLayoutInvariants,
	reduceWorkspaceLayout,
} from '../workspace-layout.svelte';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { paneIdOfSurface, paneNodeById, collectPaneNodes } from '../pane-tree';
import {
	CHAT_SURFACE_ID,
	MAX_WORKSPACE_PANES,
	type DesktopLayoutNode,
	type PaneId,
	type PaneNode,
	type SplitId,
	type SurfaceDescriptor,
	type WorkspaceLayoutMutation,
	type WorkspaceLayoutSnapshot,
} from '../surface-types';

const FILE_A: SurfaceDescriptor = {
	id: 'file:a',
	type: 'file',
	fileSessionId: 'file-session-a',
};

const TERMINAL_A: SurfaceDescriptor = {
	id: 'terminal:a',
	type: 'terminal',
	terminalId: 'a',
};

const TERMINAL_B: SurfaceDescriptor = {
	id: 'terminal:b',
	type: 'terminal',
	terminalId: 'b',
};

function pane(id: string, tabs: readonly string[]): PaneNode {
	return {
		type: 'pane',
		id: id as PaneId,
		tabs: { order: [...tabs], activeId: tabs[0] ?? null, mru: [...tabs] },
	};
}

function split(
	id: string,
	direction: 'horizontal' | 'vertical',
	children: [DesktopLayoutNode, DesktopLayoutNode],
	ratio = 0.5,
): DesktopLayoutNode {
	return { type: 'split', id: id as SplitId, direction, ratio, children };
}

function withRoot(
	snapshot: WorkspaceLayoutSnapshot,
	root: DesktopLayoutNode,
): WorkspaceLayoutSnapshot {
	return { ...snapshot, desktopRoot: root };
}

// Builds a valid snapshot whose surfaces map exactly covers the tree's
// placements, canonical chat/git/pull-requests descriptors included.
function snapshotWith(
	root: DesktopLayoutNode,
	extraSurfaces: Record<string, SurfaceDescriptor> = {},
): WorkspaceLayoutSnapshot {
	const canonical = canonicalWorkspaceSnapshot();
	const surfaces: Record<string, SurfaceDescriptor> = { ...extraSurfaces };
	for (const pane of collectPaneNodes(root)) {
		for (const surfaceId of pane.tabs.order) {
			surfaces[surfaceId] ??= canonical.surfaces[surfaceId];
		}
	}
	return { ...canonical, desktopRoot: root, surfaces };
}

function surfaceIds(snapshot: WorkspaceLayoutSnapshot, paneId: string): readonly string[] {
	return paneNodeById(snapshot.desktopRoot, paneId as PaneId)?.tabs.order ?? [];
}

function activeOf(snapshot: WorkspaceLayoutSnapshot, paneId: string): string | null {
	return paneNodeById(snapshot.desktopRoot, paneId as PaneId)?.tabs.activeId ?? null;
}

function mutate(
	base: WorkspaceLayoutSnapshot,
	mutations: readonly WorkspaceLayoutMutation[],
): WorkspaceLayoutSnapshot {
	return reduceWorkspaceLayout(base, mutations);
}

describe('workspace layout reducers', () => {
	it('creates the canonical first-run layout', () => {
		const snapshot = canonicalWorkspaceSnapshot();

		expect(snapshot.desktopRoot.type).toBe('pane');
		expect(surfaceIds(snapshot, 'pane-main')).toEqual([
			'singleton:chat',
			'singleton:git',
			'singleton:pull-requests',
		]);
		expect(activeOf(snapshot, 'pane-main')).toBe(CHAT_SURFACE_ID);
		expect(snapshot.fullscreenPaneId).toBeNull();
		expect(() => assertWorkspaceLayoutInvariants(snapshot)).not.toThrow();
	});

	it('registers surfaces into a pane and tracks mru', () => {
		const next = mutate(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: TERMINAL_A, paneId: 'pane-main' },
			{ type: 'register-surface', surface: TERMINAL_B, paneId: 'pane-main', index: 0 },
		]);
		expect(surfaceIds(next, 'pane-main')).toEqual([
			'terminal:b',
			'singleton:chat',
			'singleton:git',
			'singleton:pull-requests',
			'terminal:a',
		]);
		const tabs = paneNodeById(next.desktopRoot, 'pane-main' as PaneId)!.tabs;
		expect(tabs.activeId).toBe(CHAT_SURFACE_ID);
		expect([...tabs.mru].sort()).toEqual([...tabs.order].sort());
	});

	it('activates pane tabs', () => {
		const next = mutate(canonicalWorkspaceSnapshot(), [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);
		expect(activeOf(next, 'pane-main')).toBe('singleton:git');
		expect(paneNodeById(next.desktopRoot, 'pane-main' as PaneId)!.tabs.mru[0]).toBe(
			'singleton:git',
		);
	});

	it('rejects activation of a surface that is not in the pane', () => {
		expect(() =>
			mutate(canonicalWorkspaceSnapshot(), [
				{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:files' },
			]),
		).toThrow();
	});

	it('moves tabs between panes and activates them', () => {
		const base = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests']),
				pane('pane-2', ['singleton:files']),
			]),
			{ 'singleton:files': { id: 'singleton:files', type: 'singleton', kind: 'files' } },
		);
		const moved = mutate(base, [
			{ type: 'move-tab', surfaceId: 'singleton:git', destinationPaneId: 'pane-2' },
		]);
		expect(surfaceIds(moved, 'pane-2')).toEqual(['singleton:files', 'singleton:git']);
		expect(activeOf(moved, 'pane-2')).toBe('singleton:git');
		expect(surfaceIds(moved, 'pane-main')).toEqual([CHAT_SURFACE_ID, 'singleton:pull-requests']);
	});

	it('collapses a pane when its last tab moves out', () => {
		const valid = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git']),
				pane('pane-2', ['singleton:pull-requests']),
			]),
		);
		const next = mutate(valid, [
			{ type: 'move-tab', surfaceId: 'singleton:pull-requests', destinationPaneId: 'pane-main' },
		]);
		expect(next.desktopRoot.type).toBe('pane');
		expect(surfaceIds(next, 'pane-main')).toEqual([
			CHAT_SURFACE_ID,
			'singleton:git',
			'singleton:pull-requests',
		]);
	});

	it('rejects moving the last tab out of the root pane', () => {
		expect(() =>
			mutate(canonicalWorkspaceSnapshot(), [
				{ type: 'move-tab', surfaceId: 'singleton:git', destinationPaneId: 'pane-2' as PaneId },
			]),
		).toThrow('Pane does not exist');
	});

	it('splits a tab out to a new pane', () => {
		const next = mutate(canonicalWorkspaceSnapshot(), [
			{
				type: 'split-tab-to-edge',
				surfaceId: 'singleton:git',
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
		]);
		expect(next.desktopRoot.type).toBe('split');
		expect(surfaceIds(next, 'pane-2')).toEqual(['singleton:git']);
		expect(activeOf(next, 'pane-2')).toBe('singleton:git');
		expect(surfaceIds(next, 'pane-main')).toEqual([CHAT_SURFACE_ID, 'singleton:pull-requests']);
		expect(paneIdOfSurface(next.desktopRoot, 'singleton:git')).toBe('pane-2');
	});

	it('keeps the pane count flat when the sole tab of a pane splits into another pane', () => {
		const base = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests']),
				pane('pane-2', ['singleton:files']),
			]),
			{ 'singleton:files': { id: 'singleton:files', type: 'singleton', kind: 'files' } },
		);
		const next = mutate(base, [
			{
				type: 'split-tab-to-edge',
				surfaceId: 'singleton:files',
				targetPaneId: 'pane-main',
				edge: 'bottom',
				newPaneId: 'pane-3',
				splitId: 'split-2',
			},
		]);
		expect(collectPaneNodes(next.desktopRoot)).toHaveLength(2);
		expect(paneIdOfSurface(next.desktopRoot, 'singleton:files')).toBe('pane-3');
	});

	it('treats splitting the sole tab of a pane onto its own edge as a no-op', () => {
		const single = snapshotWith(pane('pane-main', [CHAT_SURFACE_ID]));
		const next = mutate(single, [
			{
				type: 'split-tab-to-edge',
				surfaceId: CHAT_SURFACE_ID,
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
		]);
		expect(next).toBe(single);
	});

	it('enforces the pane cap on splits from multi-tab panes', () => {
		let root: DesktopLayoutNode = pane('pane-main', [CHAT_SURFACE_ID, 'terminal:t5']);
		const extraSurfaces: Record<string, SurfaceDescriptor> = {
			'terminal:t5': { id: 'terminal:t5', type: 'terminal', terminalId: 't5' },
		};
		for (let index = 2; index <= MAX_WORKSPACE_PANES; index += 1) {
			const surfaceId = `terminal:t${index}`;
			extraSurfaces[surfaceId] = { id: surfaceId, type: 'terminal', terminalId: `t${index}` };
			root = split(`split-${index}`, 'horizontal', [root, pane(`pane-${index}`, [surfaceId])]);
		}
		const base: WorkspaceLayoutSnapshot = {
			...canonicalWorkspaceSnapshot(),
			desktopRoot: root,
			surfaces: {
				[CHAT_SURFACE_ID]: { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
				...extraSurfaces,
			},
		};
		expect(() =>
			mutate(base, [
				{
					type: 'split-tab-to-edge',
					surfaceId: CHAT_SURFACE_ID,
					targetPaneId: 'pane-2' as PaneId,
					edge: 'right',
					newPaneId: 'pane-99' as PaneId,
					splitId: 'split-99' as SplitId,
				},
			]),
		).toThrow('Pane count limit reached');
	});

	it('allows a net-zero split of a sole-tab pane at the pane cap', () => {
		let root: DesktopLayoutNode = pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git']);
		const extraSurfaces: Record<string, SurfaceDescriptor> = {};
		for (let index = 2; index <= MAX_WORKSPACE_PANES; index += 1) {
			const surfaceId = `terminal:t${index}`;
			extraSurfaces[surfaceId] = { id: surfaceId, type: 'terminal', terminalId: `t${index}` };
			root = split(`split-${index}`, 'horizontal', [root, pane(`pane-${index}`, [surfaceId])]);
		}
		const base: WorkspaceLayoutSnapshot = {
			...canonicalWorkspaceSnapshot(),
			desktopRoot: root,
			surfaces: {
				[CHAT_SURFACE_ID]: { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
				'singleton:git': { id: 'singleton:git', type: 'singleton', kind: 'git' },
				...extraSurfaces,
			},
		};
		const next = mutate(base, [
			{
				type: 'split-tab-to-edge',
				surfaceId: 'terminal:t4',
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-99' as PaneId,
				splitId: 'split-99' as SplitId,
			},
		]);
		expect(collectPaneNodes(next.desktopRoot)).toHaveLength(MAX_WORKSPACE_PANES);
		expect(paneIdOfSurface(next.desktopRoot, 'terminal:t4')).toBe('pane-99');
	});

	it('keeps assign-to-pane stable when the surface already owns the destination', () => {
		const base = snapshotWith(pane('pane-main', [CHAT_SURFACE_ID]));
		const next = mutate(base, [
			{
				type: 'assign-to-pane',
				surfaceId: CHAT_SURFACE_ID,
				destinationPaneId: 'pane-main',
			},
		]);
		expect(collectPaneNodes(next.desktopRoot)).toHaveLength(1);
		expect(surfaceIds(next, 'pane-main')).toEqual([CHAT_SURFACE_ID]);
	});

	it('registers a new surface directly into a new split pane', () => {
		const next = mutate(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-split',
				surface: TERMINAL_A,
				targetPaneId: 'pane-main',
				edge: 'bottom',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
		]);
		expect(next.desktopRoot.type).toBe('split');
		const splitNode = next.desktopRoot;
		if (splitNode.type !== 'split') throw new Error('expected split');
		expect(splitNode.direction).toBe('vertical');
		expect(surfaceIds(next, 'pane-2')).toEqual(['terminal:a']);
		expect(activeOf(next, 'pane-2')).toBe('terminal:a');
	});

	it('merges a pane into another pane', () => {
		const base = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests']),
				pane('pane-2', ['singleton:files']),
			]),
			{ 'singleton:files': { id: 'singleton:files', type: 'singleton', kind: 'files' } },
		);
		const next = mutate(base, [
			{ type: 'merge-pane', sourcePaneId: 'pane-2', destinationPaneId: 'pane-main' },
		]);
		expect(next.desktopRoot.type).toBe('pane');
		expect(surfaceIds(next, 'pane-main')).toEqual([
			CHAT_SURFACE_ID,
			'singleton:git',
			'singleton:pull-requests',
			'singleton:files',
		]);
		expect(activeOf(next, 'pane-main')).toBe(CHAT_SURFACE_ID);
	});

	it('sets and clamps split ratios', () => {
		const valid = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git']),
				pane('pane-2', ['singleton:pull-requests']),
			]),
		);
		const resized = mutate(valid, [{ type: 'set-split-ratio', splitId: 'split-1', ratio: 0.7 }]);
		expect(resized.desktopRoot.type === 'split' && resized.desktopRoot.ratio).toBe(0.7);
		const clamped = mutate(valid, [{ type: 'set-split-ratio', splitId: 'split-1', ratio: 0.95 }]);
		expect(clamped.desktopRoot.type === 'split' && clamped.desktopRoot.ratio).toBe(0.85);
	});

	it('toggles pane fullscreen and clears it when the pane disappears', () => {
		const base = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git']),
				pane('pane-2', ['singleton:pull-requests']),
			]),
		);
		const fullscreen = mutate(base, [{ type: 'set-fullscreen-pane', paneId: 'pane-2' }]);
		expect(fullscreen.fullscreenPaneId).toBe('pane-2');
		const cleared = mutate(fullscreen, [
			{ type: 'merge-pane', sourcePaneId: 'pane-2', destinationPaneId: 'pane-main' },
		]);
		expect(cleared.fullscreenPaneId).toBeNull();
		expect(() =>
			mutate(base, [{ type: 'set-fullscreen-pane', paneId: 'pane-missing' as PaneId }]),
		).toThrow('Pane does not exist');
	});

	it('moves a dialog file into a pane', () => {
		const withDialog = mutate(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: FILE_A },
			{ type: 'place-in-dialog', surfaceId: 'file:a' },
		]);
		expect(withDialog.dialogFileSurfaceId).toBe('file:a');
		expect(withDialog.mobileOnlySurfaceIds).not.toContain('file:a');
		const docked = mutate(withDialog, [
			{ type: 'move-dialog-to-pane', surfaceId: 'file:a', destinationPaneId: 'pane-main' },
		]);
		expect(docked.dialogFileSurfaceId).toBeNull();
		expect(surfaceIds(docked, 'pane-main')).toContain('file:a');
		expect(activeOf(docked, 'pane-main')).toBe('file:a');
	});

	it('rejects placing non-file surfaces in the dialog', () => {
		expect(() =>
			mutate(canonicalWorkspaceSnapshot(), [
				{ type: 'place-in-dialog', surfaceId: 'singleton:git' },
			]),
		).toThrow('Only file surfaces can enter dialog');
	});

	it('unplaces and forgets terminals, collapsing emptied panes', () => {
		const base = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests']),
				pane('pane-2', ['terminal:a']),
			]),
			{ 'terminal:a': TERMINAL_A },
		);
		const unplaced = mutate(base, [{ type: 'unplace-terminal', terminalId: 'a' }]);
		expect(unplaced.desktopRoot.type).toBe('pane');
		expect(unplaced.unplacedTerminalIds).toEqual(['a']);
		expect(unplaced.surfaces['terminal:a']).toBeUndefined();

		const forgotten = mutate(unplaced, [{ type: 'forget-terminal', terminalId: 'a' }]);
		expect(forgotten.unplacedTerminalIds).toEqual([]);
	});

	it('swaps terminal placements across panes', () => {
		const base = snapshotWith(
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'terminal:a']),
				pane('pane-2', ['terminal:b']),
			]),
			{ 'terminal:a': TERMINAL_A, 'terminal:b': TERMINAL_B },
		);
		const swapped = mutate(base, [
			{
				type: 'swap-terminal-placements',
				firstSurfaceId: 'terminal:a',
				secondSurfaceId: 'terminal:b',
			},
		]);
		expect(surfaceIds(swapped, 'pane-main')).toEqual([CHAT_SURFACE_ID, 'terminal:b']);
		expect(surfaceIds(swapped, 'pane-2')).toEqual(['terminal:a']);
	});

	it('replaces surfaces in place', () => {
		const withTerminal = mutate(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: TERMINAL_A, paneId: 'pane-main' },
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'terminal:a' },
		]);
		const replaced = mutate(withTerminal, [
			{
				type: 'replace-surface',
				previousId: 'terminal:a',
				surface: TERMINAL_B,
			},
		]);
		expect(surfaceIds(replaced, 'pane-main')).toContain('terminal:b');
		expect(activeOf(replaced, 'pane-main')).toBe('terminal:b');
		expect(replaced.unplacedTerminalIds).toEqual(['a']);
	});

	it('removes surfaces and keeps chat', () => {
		expect(() =>
			mutate(canonicalWorkspaceSnapshot(), [{ type: 'remove-surface', surfaceId: CHAT_SURFACE_ID }]),
		).toThrow('Chat cannot close');
		const next = mutate(canonicalWorkspaceSnapshot(), [
			{ type: 'remove-surface', surfaceId: 'singleton:git' },
		]);
		expect(surfaceIds(next, 'pane-main')).toEqual([CHAT_SURFACE_ID, 'singleton:pull-requests']);
	});

	it('rejects duplicate surfaces and duplicate pane ids', () => {
		expect(() =>
			mutate(canonicalWorkspaceSnapshot(), [
				{
					type: 'register-surface',
					surface: { id: CHAT_SURFACE_ID, type: 'singleton', kind: 'chat' },
					paneId: 'pane-main',
				},
			]),
		).toThrow('Surface already exists');
		const duplicated = withRoot(
			canonicalWorkspaceSnapshot(),
			split('split-1', 'horizontal', [
				pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests']),
				pane('pane-main', ['singleton:git']),
			]),
		);
		expect(() => assertWorkspaceLayoutInvariants(duplicated)).toThrow('Pane ID is duplicated');
	});

	it('requires surfaces to have exactly one ownership bucket', () => {
		const dangling = withRoot(
			canonicalWorkspaceSnapshot(),
			pane('pane-main', [CHAT_SURFACE_ID, 'singleton:git', 'singleton:pull-requests', 'file:x']),
		);
		expect(() => assertWorkspaceLayoutInvariants(dangling)).toThrow(
			'Placement references missing surface',
		);
	});

	it('tracks store revisions on publish', () => {
		const store = new WorkspaceLayoutStore();
		expect(store.revision).toBe(0);
		const next = mutate(store.snapshot, [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);
		expect(store.publish(store.revision, next)).toBe(true);
		expect(store.revision).toBe(1);
		expect(store.chatPaneId).toBe('pane-main');
		expect(store.defaultActiveId).toBe('singleton:git');
	});

	it('rejects stale revisions on publish', () => {
		const store = new WorkspaceLayoutStore();
		const next = mutate(store.snapshot, [
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);
		expect(store.publish(5, next)).toBe(false);
		expect(store.revision).toBe(0);
	});
});
