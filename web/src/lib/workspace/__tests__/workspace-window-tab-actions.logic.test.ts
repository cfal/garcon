import { describe, expect, it } from 'vitest';
import type {
	DesktopWorkspaceNode,
	SurfaceDescriptor,
	WorkspaceLayoutSnapshot,
	WorkspaceWindowId,
	WorkspaceWindowNode,
} from '../surface-types';
import { chatViewSurfaceId } from '../surface-types';
import { resolveWorkspaceWindowTabActions } from '../workspace-window-tab-actions';
import { resolveUnmeasuredWorkspaceSplit } from './workspace-geometry-test-fixtures';

function resolveActions(
	snapshot: WorkspaceLayoutSnapshot,
	workspaceWindow: WorkspaceWindowNode,
	surfaceId: string,
) {
	return resolveWorkspaceWindowTabActions(
		snapshot,
		workspaceWindow.id,
		workspaceWindow.tabs,
		surfaceId,
		(edge, movingSurfaceId) =>
			resolveUnmeasuredWorkspaceSplit(snapshot, {
				targetWindowId: workspaceWindow.id,
				edge,
				movingSurfaceId,
			}),
	);
}

function workspaceWindow(id: WorkspaceWindowId, order: readonly string[]): WorkspaceWindowNode {
	const activeId = order[0];
	if (!activeId) throw new Error(`Test window is empty: ${id}`);
	return {
		type: 'window',
		id,
		tabs: { order, activeId, mru: order },
	};
}

function partition(
	id: `partition-${string}`,
	first: DesktopWorkspaceNode,
	second: DesktopWorkspaceNode,
): DesktopWorkspaceNode {
	return {
		type: 'partition',
		id,
		direction: 'horizontal',
		ratio: 0.5,
		children: [first, second],
	};
}

function snapshotWithWindows(
	windows: readonly WorkspaceWindowNode[],
	chatId: string | null,
): WorkspaceLayoutSnapshot {
	const firstWindow = windows[0];
	if (!firstWindow) throw new Error('Test snapshot needs a window');
	let desktopRoot: DesktopWorkspaceNode = firstWindow;
	for (let index = 1; index < windows.length; index += 1) {
		const nextWindow = windows[index];
		if (!nextWindow) continue;
		desktopRoot = partition(`partition-${index}`, desktopRoot, nextWindow);
	}
	const surfaces: Record<string, SurfaceDescriptor> = {};
	for (const workspaceWindow of windows) {
		for (const surfaceId of workspaceWindow.tabs.order) {
			if (surfaceId.startsWith('chat-view:')) {
				surfaces[surfaceId] = {
					id: surfaceId as `chat-view:${WorkspaceWindowId}`,
					type: 'chat',
					chatId,
				};
				continue;
			}
			if (surfaceId.startsWith('terminal:')) {
				surfaces[surfaceId] = {
					id: surfaceId,
					type: 'terminal',
					terminalId: surfaceId.slice('terminal:'.length),
				};
			}
		}
	}
	return {
		desktopRoot,
		surfaces,
		fullscreenWindowId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: firstWindow.tabs.activeId,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
	};
}

describe('workspace window tab actions', () => {
	it('offers a populated Chat every other window and directional movement', () => {
		const source = workspaceWindow('window-source', [
			chatViewSurfaceId('window-source'),
			'terminal:source',
		]);
		const destination = workspaceWindow('window-destination', ['terminal:destination']);
		const snapshot = snapshotWithWindows([source, destination], 'chat-a');

		const actions = resolveActions(snapshot, source, chatViewSurfaceId(source.id));

		expect(actions.canMoveBetweenWindows).toBe(true);
		expect(actions.otherWindows.map((workspaceWindow) => workspaceWindow.id)).toEqual([
			'window-destination',
		]);
		expect(Object.values(actions.newWindowEdges).every((result) => result?.allowed)).toBe(true);
	});

	it('keeps existing-window movement but disables a sole Chat directional no-op', () => {
		const source = workspaceWindow('window-source', [chatViewSurfaceId('window-source')]);
		const destination = workspaceWindow('window-destination', ['terminal:destination']);
		const snapshot = snapshotWithWindows([source, destination], 'chat-a');

		const actions = resolveActions(snapshot, source, chatViewSurfaceId(source.id));

		expect(actions.canMoveBetweenWindows).toBe(true);
		expect(actions.otherWindows).toHaveLength(1);
		expect(Object.values(actions.newWindowEdges)).toEqual([null, null, null, null]);
	});

	it('disables a sole ordinary tab directional no-op', () => {
		const source = workspaceWindow('window-source', ['terminal:source']);
		const destination = workspaceWindow('window-destination', [
			chatViewSurfaceId('window-destination'),
		]);
		const snapshot = snapshotWithWindows([source, destination], 'chat-a');

		const actions = resolveActions(snapshot, source, 'terminal:source');

		expect(actions.canMoveBetweenWindows).toBe(true);
		expect(Object.values(actions.newWindowEdges)).toEqual([null, null, null, null]);
	});

	it('offers no cross-window movement for an empty Chat view', () => {
		const source = workspaceWindow('window-source', [
			chatViewSurfaceId('window-source'),
			'terminal:source',
		]);
		const destination = workspaceWindow('window-destination', ['terminal:destination']);
		const snapshot = snapshotWithWindows([source, destination], null);

		const actions = resolveActions(snapshot, source, chatViewSurfaceId(source.id));

		expect(actions.canMoveBetweenWindows).toBe(false);
		expect(actions.otherWindows).toEqual([]);
		expect(Object.values(actions.newWindowEdges)).toEqual([null, null, null, null]);
	});

	it('keeps existing destinations available while disabling new windows at the cap', () => {
		const source = workspaceWindow('window-source', [
			chatViewSurfaceId('window-source'),
			'terminal:source',
		]);
		const snapshot = snapshotWithWindows(
			[
				source,
				workspaceWindow('window-two', ['terminal:two']),
				workspaceWindow('window-three', ['terminal:three']),
				workspaceWindow('window-four', ['terminal:four']),
				...Array.from({ length: 4 }, (_, index) =>
					workspaceWindow(`window-extra-${index}`, [`terminal:extra-${index}`]),
				),
			],
			'chat-a',
		);

		const actions = resolveActions(snapshot, source, chatViewSurfaceId(source.id));

		expect(actions.otherWindows).toHaveLength(7);
		expect(
			Object.values(actions.newWindowEdges).every(
				(result) => !result?.allowed && result?.reason === 'resource-ceiling',
			),
		).toBe(true);
	});

	it('preserves edge-specific admission results', () => {
		const source = workspaceWindow('window-source', [
			chatViewSurfaceId('window-source'),
			'terminal:source',
		]);
		const snapshot = snapshotWithWindows([source], 'chat-a');
		const actions = resolveWorkspaceWindowTabActions(
			snapshot,
			source.id,
			source.tabs,
			chatViewSurfaceId(source.id),
			(edge) => (edge === 'top' ? { allowed: true } : { allowed: false, reason: 'too-small' }),
		);

		expect(actions.newWindowEdges.top).toEqual({ allowed: true });
		expect(actions.newWindowEdges.left).toEqual({ allowed: false, reason: 'too-small' });
	});
});
