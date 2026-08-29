import { describe, expect, it } from 'vitest';
import {
	CANONICAL_CHAT_SURFACE_ID,
	CANONICAL_WINDOW_ID,
	canonicalWorkspaceSnapshot,
} from '../canonical-layout';
import {
	MAX_WORKSPACE_WINDOWS,
	TERMINAL_LAUNCHER_ID,
	chatViewSurfaceId,
	fileSurfaceId,
	portableSingletonDescriptor,
	terminalSurfaceId,
	type DesktopWorkspaceNode,
	type SurfaceDescriptor,
	type WorkspaceLayoutSnapshot,
	type WorkspaceWindowId,
	type WorkspaceWindowNode,
} from '../surface-types';
import {
	WorkspaceLayoutStore,
	assertWorkspaceLayoutInvariants,
	reduceWorkspaceLayout,
} from '../workspace-layout.svelte';
import { collectWindowNodes, windowNodeById } from '../window-tree';

function workspaceWindow(
	id: WorkspaceWindowId,
	order: readonly string[],
	activeId = order[0],
): WorkspaceWindowNode {
	return {
		type: 'window',
		id,
		tabs: { order, activeId, mru: [activeId, ...order.filter((item) => item !== activeId)] },
	};
}

function partition(
	id: `partition-${string}`,
	first: DesktopWorkspaceNode,
	second: DesktopWorkspaceNode,
	direction: 'horizontal' | 'vertical' = 'horizontal',
	ratio = 0.5,
): DesktopWorkspaceNode {
	return { type: 'partition', id, direction, ratio, children: [first, second] };
}

function descriptorFor(surfaceId: string): SurfaceDescriptor {
	if (surfaceId.startsWith('chat-view:window-')) {
		return { id: surfaceId as `chat-view:window-${string}`, type: 'chat', chatId: null };
	}
	if (surfaceId.startsWith('singleton:')) {
		return portableSingletonDescriptor(
			surfaceId.slice('singleton:'.length) as Parameters<typeof portableSingletonDescriptor>[0],
		);
	}
	if (surfaceId.startsWith('terminal:')) {
		return { id: surfaceId, type: 'terminal', terminalId: surfaceId.slice('terminal:'.length) };
	}
	if (surfaceId.startsWith('file:')) {
		return { id: surfaceId, type: 'file', fileSessionId: surfaceId.slice('file:'.length) };
	}
	if (surfaceId === TERMINAL_LAUNCHER_ID) return { id: surfaceId, type: 'terminal-launcher' };
	throw new Error(`Unknown test surface: ${surfaceId}`);
}

function snapshotWith(
	desktopRoot: DesktopWorkspaceNode,
	overrides: Partial<WorkspaceLayoutSnapshot> = {},
): WorkspaceLayoutSnapshot {
	const ids = collectWindowNodes(desktopRoot).flatMap((candidate) => candidate.tabs.order);
	const surfaces = Object.fromEntries(
		ids.map((surfaceId) => [surfaceId, descriptorFor(surfaceId)]),
	);
	return {
		desktopRoot,
		surfaces,
		fullscreenWindowId: null,
		dialogFileSurfaceId: null,
		mobileActiveSurfaceId: collectWindowNodes(desktopRoot)[0].tabs.activeId,
		mobileOnlySurfaceIds: [],
		mobileReturnStack: [],
		unplacedTerminalIds: [],
		...overrides,
	};
}

function tabs(snapshot: WorkspaceLayoutSnapshot, windowId: WorkspaceWindowId): readonly string[] {
	const node = windowNodeById(snapshot.desktopRoot, windowId);
	if (!node) throw new Error(`Missing test window: ${windowId}`);
	return node.tabs.order;
}

describe('workspace layout reducer', () => {
	it('replaces the current window Chat in place and activates its stable tab', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: CANONICAL_WINDOW_ID,
				index: 0,
			},
			{
				type: 'activate-window-tab',
				windowId: CANONICAL_WINDOW_ID,
				surfaceId: 'singleton:git',
			},
		]);
		const beforeOrder = [...tabs(base, CANONICAL_WINDOW_ID)];
		const next = reduceWorkspaceLayout(base, [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId: 'chat-b' },
		]);

		expect(tabs(next, CANONICAL_WINDOW_ID)).toEqual(beforeOrder);
		expect(windowNodeById(next.desktopRoot, CANONICAL_WINDOW_ID)?.tabs.activeId).toBe(
			CANONICAL_CHAT_SURFACE_ID,
		);
		expect(next.surfaces[CANONICAL_CHAT_SURFACE_ID]).toEqual({
			id: CANONICAL_CHAT_SURFACE_ID,
			type: 'chat',
			chatId: 'chat-b',
		});
	});

	it('inserts a missing Chat view at index zero in the exact window', () => {
		const root = partition(
			'partition-root',
			workspaceWindow('window-left', ['singleton:git']),
			workspaceWindow('window-right', ['singleton:files']),
		);
		const next = reduceWorkspaceLayout(snapshotWith(root), [
			{ type: 'set-window-chat', windowId: 'window-right', chatId: 'chat-r' },
		]);

		expect(tabs(next, 'window-left')).toEqual(['singleton:git']);
		expect(tabs(next, 'window-right')).toEqual(['chat-view:window-right', 'singleton:files']);
		expect(windowNodeById(next.desktopRoot, 'window-right')?.tabs.activeId).toBe(
			'chat-view:window-right',
		);
	});

	it('allows the same chat record in different window-owned Chat views', () => {
		const next = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId: 'same-chat' },
			{
				type: 'open-chat-in-new-window',
				chatId: 'same-chat',
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-two',
				partitionId: 'partition-root',
			},
		]);

		expect(next.surfaces[CANONICAL_CHAT_SURFACE_ID]).toMatchObject({ chatId: 'same-chat' });
		expect(next.surfaces[chatViewSurfaceId('window-two')]).toMatchObject({ chatId: 'same-chat' });
	});

	it('registers, activates, reorders, and moves ordinary tabs window-locally', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: CANONICAL_WINDOW_ID,
			},
			{
				type: 'register-surface-in-new-window',
				surface: portableSingletonDescriptor('files'),
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-files',
				partitionId: 'partition-root',
			},
		]);
		const reordered = reduceWorkspaceLayout(base, [
			{
				type: 'move-tab',
				surfaceId: 'singleton:git',
				destinationWindowId: CANONICAL_WINDOW_ID,
				index: 0,
			},
		]);
		const moved = reduceWorkspaceLayout(reordered, [
			{
				type: 'move-tab',
				surfaceId: 'singleton:git',
				destinationWindowId: 'window-files',
				index: 0,
			},
		]);

		expect(tabs(reordered, CANONICAL_WINDOW_ID)).toEqual([
			'singleton:git',
			CANONICAL_CHAT_SURFACE_ID,
		]);
		expect(tabs(moved, CANONICAL_WINDOW_ID)).toEqual([CANONICAL_CHAT_SURFACE_ID]);
		expect(tabs(moved, 'window-files')).toEqual(['singleton:git', 'singleton:files']);
		expect(windowNodeById(moved.desktopRoot, 'window-files')?.tabs.activeId).toBe('singleton:git');
	});

	it('keeps a nonactivating assignment nonactivating in the destination', () => {
		const base = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-left', [chatViewSurfaceId('window-left'), 'singleton:git']),
				workspaceWindow('window-right', ['singleton:files']),
			),
		);
		const next = reduceWorkspaceLayout(base, [
			{
				type: 'assign-to-window',
				surfaceId: 'singleton:git',
				destinationWindowId: 'window-right',
				index: 0,
			},
		]);

		expect(tabs(next, 'window-right')).toEqual(['singleton:git', 'singleton:files']);
		expect(windowNodeById(next.desktopRoot, 'window-right')?.tabs.activeId).toBe('singleton:files');
	});

	it('opens a tab in a new window and atomically collapses a sole-tab source', () => {
		const base = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-chat', [chatViewSurfaceId('window-chat')]),
				workspaceWindow('window-git', ['singleton:git']),
			),
		);
		const next = reduceWorkspaceLayout(base, [
			{
				type: 'move-tab-to-new-window',
				surfaceId: 'singleton:git',
				targetWindowId: 'window-chat',
				edge: 'bottom',
				newWindowId: 'window-new',
				partitionId: 'partition-new',
			},
		]);

		expect(collectWindowNodes(next.desktopRoot).map((item) => item.id)).toEqual([
			'window-chat',
			'window-new',
		]);
		expect(tabs(next, 'window-new')).toEqual(['singleton:git']);
	});

	it('reorders a Chat view locally but keeps generic cross-window movement rejected', () => {
		const local = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: CANONICAL_WINDOW_ID,
			},
			{
				type: 'move-tab',
				surfaceId: CANONICAL_CHAT_SURFACE_ID,
				destinationWindowId: CANONICAL_WINDOW_ID,
				index: 1,
			},
		]);
		expect(tabs(local, CANONICAL_WINDOW_ID)).toEqual(['singleton:git', CANONICAL_CHAT_SURFACE_ID]);

		const withSecondWindow = reduceWorkspaceLayout(local, [
			{
				type: 'register-surface-in-new-window',
				surface: portableSingletonDescriptor('files'),
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-files',
				partitionId: 'partition-files',
			},
		]);
		expect(() =>
			reduceWorkspaceLayout(withSecondWindow, [
				{
					type: 'move-tab',
					surfaceId: CANONICAL_CHAT_SURFACE_ID,
					destinationWindowId: 'window-files',
				},
			]),
		).toThrow('cannot move');
	});

	it('moves Chat into a Chat-less window and rekeys transient references', () => {
		const sourceSurfaceId = chatViewSurfaceId('window-source');
		const destinationSurfaceId = chatViewSurfaceId('window-destination');
		const initial = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-source', [sourceSurfaceId, 'singleton:git']),
				workspaceWindow('window-destination', ['singleton:files']),
			),
		);
		const base: WorkspaceLayoutSnapshot = {
			...initial,
			surfaces: {
				...initial.surfaces,
				[sourceSurfaceId]: { id: sourceSurfaceId, type: 'chat', chatId: 'chat-a' },
			},
			fullscreenWindowId: 'window-source',
			mobileActiveSurfaceId: sourceSurfaceId,
			mobileReturnStack: [
				{
					invokerSurfaceId: sourceSurfaceId,
					invokerHost: 'window-source',
					chatId: 'chat-a',
					effectiveProjectKey: null,
					routeIdentity: '/chat/chat-a',
				},
			],
		};

		const next = reduceWorkspaceLayout(base, [
			{
				type: 'move-chat-to-window',
				sourceWindowId: 'window-source',
				destinationWindowId: 'window-destination',
			},
		]);

		expect(tabs(next, 'window-source')).toEqual(['singleton:git']);
		expect(tabs(next, 'window-destination')).toEqual([destinationSurfaceId, 'singleton:files']);
		expect(windowNodeById(next.desktopRoot, 'window-destination')?.tabs.activeId).toBe(
			destinationSurfaceId,
		);
		expect(next.surfaces[sourceSurfaceId]).toBeUndefined();
		expect(next.surfaces[destinationSurfaceId]).toEqual({
			id: destinationSurfaceId,
			type: 'chat',
			chatId: 'chat-a',
		});
		expect(next.mobileActiveSurfaceId).toBe(destinationSurfaceId);
		expect(next.mobileReturnStack[0]?.invokerSurfaceId).toBe(destinationSurfaceId);
		expect(next.fullscreenWindowId).toBeNull();
	});

	it('replaces destination Chat in place and collapses a sole-tab source window', () => {
		const sourceSurfaceId = chatViewSurfaceId('window-source');
		const destinationSurfaceId = chatViewSurfaceId('window-destination');
		const initial = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-source', [sourceSurfaceId]),
				workspaceWindow(
					'window-destination',
					['singleton:git', destinationSurfaceId, 'singleton:files'],
					'singleton:files',
				),
			),
		);
		const base: WorkspaceLayoutSnapshot = {
			...initial,
			surfaces: {
				...initial.surfaces,
				[sourceSurfaceId]: { id: sourceSurfaceId, type: 'chat', chatId: 'chat-a' },
				[destinationSurfaceId]: {
					id: destinationSurfaceId,
					type: 'chat',
					chatId: 'chat-b',
				},
			},
			fullscreenWindowId: 'window-destination',
		};

		const next = reduceWorkspaceLayout(base, [
			{
				type: 'move-chat-to-window',
				sourceWindowId: 'window-source',
				destinationWindowId: 'window-destination',
			},
		]);

		expect(collectWindowNodes(next.desktopRoot).map((item) => item.id)).toEqual([
			'window-destination',
		]);
		expect(tabs(next, 'window-destination')).toEqual([
			'singleton:git',
			destinationSurfaceId,
			'singleton:files',
		]);
		expect(windowNodeById(next.desktopRoot, 'window-destination')?.tabs.activeId).toBe(
			destinationSurfaceId,
		);
		expect(next.surfaces[sourceSurfaceId]).toBeUndefined();
		expect(next.surfaces[destinationSurfaceId]).toMatchObject({ chatId: 'chat-a' });
		expect(Object.values(next.surfaces).filter((surface) => surface.type === 'chat')).toHaveLength(
			1,
		);
		expect(next.fullscreenWindowId).toBe('window-destination');
	});

	it('rejects moving an empty Chat view or moving Chat to its source window', () => {
		const sourceSurfaceId = chatViewSurfaceId('window-source');
		const base = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-source', [sourceSurfaceId, 'singleton:git']),
				workspaceWindow('window-destination', ['singleton:files']),
			),
		);

		expect(() =>
			reduceWorkspaceLayout(base, [
				{
					type: 'move-chat-to-window',
					sourceWindowId: 'window-source',
					destinationWindowId: 'window-destination',
				},
			]),
		).toThrow('empty');

		const populated = reduceWorkspaceLayout(base, [
			{ type: 'set-window-chat', windowId: 'window-source', chatId: 'chat-a' },
		]);
		expect(() =>
			reduceWorkspaceLayout(populated, [
				{
					type: 'move-chat-to-window',
					sourceWindowId: 'window-source',
					destinationWindowId: 'window-source',
				},
			]),
		).toThrow('different');
	});

	it('moves a populated Chat tab to a new window with a destination-derived identity', () => {
		const sourceSurfaceId = chatViewSurfaceId('window-source');
		const destinationSurfaceId = chatViewSurfaceId('window-new');
		const initial = snapshotWith(
			workspaceWindow('window-source', [sourceSurfaceId, 'singleton:git']),
		);
		const base: WorkspaceLayoutSnapshot = {
			...initial,
			surfaces: {
				...initial.surfaces,
				[sourceSurfaceId]: { id: sourceSurfaceId, type: 'chat', chatId: 'chat-a' },
			},
			fullscreenWindowId: 'window-source',
			mobileActiveSurfaceId: sourceSurfaceId,
		};

		const next = reduceWorkspaceLayout(base, [
			{
				type: 'move-tab-to-new-window',
				surfaceId: sourceSurfaceId,
				targetWindowId: 'window-source',
				edge: 'right',
				newWindowId: 'window-new',
				partitionId: 'partition-new',
			},
		]);

		expect(tabs(next, 'window-source')).toEqual(['singleton:git']);
		expect(tabs(next, 'window-new')).toEqual([destinationSurfaceId]);
		expect(next.surfaces[sourceSurfaceId]).toBeUndefined();
		expect(next.surfaces[destinationSurfaceId]).toEqual({
			id: destinationSurfaceId,
			type: 'chat',
			chatId: 'chat-a',
		});
		expect(next.mobileActiveSurfaceId).toBe(destinationSurfaceId);
		expect(next.fullscreenWindowId).toBeNull();
	});

	it('keeps a sole-tab directional Chat move as an identity no-op', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId: 'chat-a' },
		]);
		const next = reduceWorkspaceLayout(base, [
			{
				type: 'move-tab-to-new-window',
				surfaceId: CANONICAL_CHAT_SURFACE_ID,
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-new',
				partitionId: 'partition-new',
			},
		]);

		expect(next).toBe(base);
	});

	it('allows closing a Chat view only while another Chat view remains', () => {
		expect(() =>
			reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
				{ type: 'remove-surface', surfaceId: CANONICAL_CHAT_SURFACE_ID },
			]),
		).toThrow('At least one Chat view');

		const duplicateChat = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'open-chat-in-new-window',
				chatId: 'chat-b',
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-chat-b',
				partitionId: 'partition-chat-b',
			},
		]);
		const next = reduceWorkspaceLayout(duplicateChat, [
			{ type: 'remove-surface', surfaceId: CANONICAL_CHAT_SURFACE_ID },
		]);
		expect(next.surfaces[CANONICAL_CHAT_SURFACE_ID]).toBeUndefined();
		expect(collectWindowNodes(next.desktopRoot).map((item) => item.id)).toEqual(['window-chat-b']);
	});

	it('enforces the four-window cap while allowing a net-zero edge move', () => {
		let root: DesktopWorkspaceNode = workspaceWindow('window-1', [chatViewSurfaceId('window-1')]);
		for (let index = 2; index <= MAX_WORKSPACE_WINDOWS; index += 1) {
			root = partition(
				`partition-${index}`,
				root,
				workspaceWindow(`window-${index}`, [`terminal:${index}`]),
			);
		}
		const full = snapshotWith(root);
		const netZero = reduceWorkspaceLayout(full, [
			{
				type: 'move-tab-to-new-window',
				surfaceId: 'terminal:4',
				targetWindowId: 'window-1',
				edge: 'left',
				newWindowId: 'window-replaced',
				partitionId: 'partition-replaced',
			},
		]);
		expect(collectWindowNodes(netZero.desktopRoot)).toHaveLength(MAX_WORKSPACE_WINDOWS);

		const withExtraTab = reduceWorkspaceLayout(full, [
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: 'window-4',
			},
		]);
		expect(() =>
			reduceWorkspaceLayout(withExtraTab, [
				{
					type: 'move-tab-to-new-window',
					surfaceId: 'singleton:git',
					targetWindowId: 'window-1',
					edge: 'right',
					newWindowId: 'window-overflow',
					partitionId: 'partition-overflow',
				},
			]),
		).toThrow('count limit');

		const populatedChat = reduceWorkspaceLayout(full, [
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: 'window-1',
			},
			{ type: 'set-window-chat', windowId: 'window-1', chatId: 'chat-a' },
		]);
		expect(() =>
			reduceWorkspaceLayout(populatedChat, [
				{
					type: 'move-tab-to-new-window',
					surfaceId: chatViewSurfaceId('window-1'),
					targetWindowId: 'window-1',
					edge: 'right',
					newWindowId: 'window-chat-overflow',
					partitionId: 'partition-chat-overflow',
				},
			]),
		).toThrow('count limit');
	});

	it('closes a whole window without merging its tabs and unplaces terminals', () => {
		const base = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-chat', [chatViewSurfaceId('window-chat')]),
				workspaceWindow('window-tools', ['singleton:git', 'terminal:t1']),
			),
		);
		const next = reduceWorkspaceLayout(base, [{ type: 'close-window', windowId: 'window-tools' }]);

		expect(next.desktopRoot).toEqual(
			workspaceWindow('window-chat', [chatViewSurfaceId('window-chat')]),
		);
		expect(next.surfaces['singleton:git']).toBeUndefined();
		expect(next.surfaces['terminal:t1']).toBeUndefined();
		expect(next.unplacedTerminalIds).toEqual(['t1']);
		expect(() =>
			reduceWorkspaceLayout(next, [{ type: 'close-window', windowId: 'window-chat' }]),
		).toThrow('At least one');
	});

	it('rejects closing the window that owns the final Chat view', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-new-window',
				surface: portableSingletonDescriptor('git'),
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-git',
				partitionId: 'partition-git',
			},
		]);

		expect(() =>
			reduceWorkspaceLayout(base, [{ type: 'close-window', windowId: CANONICAL_WINDOW_ID }]),
		).toThrow('At least one Chat view');
	});

	it('keeps the exact topology while fullscreen is entered and exited', () => {
		const base = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-chat', [chatViewSurfaceId('window-chat'), 'singleton:git']),
				workspaceWindow('window-terminal', ['terminal:t2']),
			),
		);
		const entered = reduceWorkspaceLayout(base, [
			{ type: 'set-fullscreen-window', windowId: 'window-chat' },
		]);

		expect(entered.desktopRoot).toBe(base.desktopRoot);
		expect(entered.surfaces).toBe(base.surfaces);
		expect(entered.fullscreenWindowId).toBe('window-chat');
		const exited = reduceWorkspaceLayout(entered, [
			{ type: 'set-fullscreen-window', windowId: null },
		]);
		expect(exited.fullscreenWindowId).toBeNull();
		expect(exited.desktopRoot).toBe(base.desktopRoot);
		expect(exited.surfaces).toBe(base.surfaces);
	});

	it('clears fullscreen when a new window is opened', () => {
		const fullscreen = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-fullscreen-window', windowId: CANONICAL_WINDOW_ID },
		]);
		const next = reduceWorkspaceLayout(fullscreen, [
			{
				type: 'register-surface-in-new-window',
				surface: portableSingletonDescriptor('git'),
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-git',
				partitionId: 'partition-root',
			},
		]);
		expect(next.fullscreenWindowId).toBeNull();
	});

	it('clamps partition ratios and preserves complete MRU state', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-new-window',
				surface: portableSingletonDescriptor('git'),
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-git',
				partitionId: 'partition-root',
			},
		]);
		const next = reduceWorkspaceLayout(base, [
			{ type: 'set-partition-ratio', partitionId: 'partition-root', ratio: 5 },
		]);
		expect(next.desktopRoot.type).toBe('partition');
		if (next.desktopRoot.type !== 'partition') throw new Error('Expected partition root');
		expect(next.desktopRoot.ratio).toBe(0.85);
		for (const item of collectWindowNodes(next.desktopRoot)) {
			expect(new Set(item.tabs.mru)).toEqual(new Set(item.tabs.order));
		}
	});

	it('moves file surfaces through dialog and back into an exact window', () => {
		const fileId = fileSurfaceId('f1');
		const registered = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: fileId, type: 'file', fileSessionId: 'f1' },
				windowId: CANONICAL_WINDOW_ID,
			},
		]);
		const dialog = reduceWorkspaceLayout(registered, [
			{ type: 'place-in-dialog', surfaceId: fileId },
		]);
		expect(dialog.dialogFileSurfaceId).toBe(fileId);
		expect(tabs(dialog, CANONICAL_WINDOW_ID)).toEqual([CANONICAL_CHAT_SURFACE_ID]);

		const restored = reduceWorkspaceLayout(dialog, [
			{
				type: 'move-dialog-to-window',
				surfaceId: fileId,
				destinationWindowId: CANONICAL_WINDOW_ID,
			},
		]);
		expect(restored.dialogFileSurfaceId).toBeNull();
		expect(windowNodeById(restored.desktopRoot, CANONICAL_WINDOW_ID)?.tabs.activeId).toBe(fileId);
	});

	it('tracks unplaced and replaced terminal identities', () => {
		const firstId = terminalSurfaceId('a');
		const secondId = terminalSurfaceId('b');
		const placed = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: firstId, type: 'terminal', terminalId: 'a' },
				windowId: CANONICAL_WINDOW_ID,
			},
			{
				type: 'replace-surface',
				previousId: firstId,
				surface: { id: secondId, type: 'terminal', terminalId: 'b' },
			},
		]);
		expect(placed.unplacedTerminalIds).toEqual(['a']);
		const unplaced = reduceWorkspaceLayout(placed, [{ type: 'unplace-terminal', terminalId: 'b' }]);
		expect(unplaced.surfaces[secondId]).toBeUndefined();
		expect(unplaced.unplacedTerminalIds).toEqual(['a', 'b']);
	});
});

describe('workspace layout invariants', () => {
	it('rejects a Chat descriptor in the wrong window or two Chat views in one window', () => {
		const wrong = snapshotWith(workspaceWindow('window-wrong', [CANONICAL_CHAT_SURFACE_ID]));
		expect(() => assertWorkspaceLayoutInvariants(wrong)).toThrow('does not match');

		const secondChat = chatViewSurfaceId('window-second');
		const duplicate = snapshotWith(
			workspaceWindow('window-main', [CANONICAL_CHAT_SURFACE_ID, secondChat]),
		);
		expect(() => assertWorkspaceLayoutInvariants(duplicate)).toThrow('more than one Chat');
	});

	it('rejects invalid prefixes, duplicate IDs, stale MRU, and missing fullscreen windows', () => {
		const badPrefix = {
			...canonicalWorkspaceSnapshot(),
			desktopRoot: { ...canonicalWorkspaceSnapshot().desktopRoot, id: 'main' },
		} as unknown as WorkspaceLayoutSnapshot;
		expect(() => assertWorkspaceLayoutInvariants(badPrefix)).toThrow('invalid prefix');

		const duplicate = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-dup', [CANONICAL_CHAT_SURFACE_ID]),
				workspaceWindow('window-dup', ['singleton:git']),
			),
		);
		expect(() => assertWorkspaceLayoutInvariants(duplicate)).toThrow('duplicated');

		const staleMru = canonicalWorkspaceSnapshot();
		if (staleMru.desktopRoot.type !== 'window') throw new Error('Expected window root');
		const invalidMru = {
			...staleMru,
			desktopRoot: {
				...staleMru.desktopRoot,
				tabs: { ...staleMru.desktopRoot.tabs, mru: ['missing'] },
			},
		};
		expect(() => assertWorkspaceLayoutInvariants(invalidMru)).toThrow('MRU');

		const twoWindows = snapshotWith(
			partition(
				'partition-root',
				workspaceWindow('window-main', [CANONICAL_CHAT_SURFACE_ID]),
				workspaceWindow('window-git', ['singleton:git']),
			),
			{ fullscreenWindowId: 'window-main' },
		);
		expect(() => assertWorkspaceLayoutInvariants(twoWindows)).not.toThrow();
		expect(() =>
			assertWorkspaceLayoutInvariants({
				...twoWindows,
				fullscreenWindowId: 'window-missing',
			}),
		).toThrow('Fullscreen');
	});
});

describe('WorkspaceLayoutStore', () => {
	it('publishes only the expected revision and exposes the first window defaults', () => {
		const store = new WorkspaceLayoutStore();
		expect(store.defaultWindowId).toBe(CANONICAL_WINDOW_ID);
		expect(store.defaultActiveId).toBe(CANONICAL_CHAT_SURFACE_ID);
		const next = reduceWorkspaceLayout(store.snapshot, [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId: 'chat-a' },
		]);
		expect(store.publish(1, next)).toBe(false);
		expect(store.publish(0, next)).toBe(true);
		expect(store.revision).toBe(1);
		expect(store.surface(CANONICAL_CHAT_SURFACE_ID)).toMatchObject({ chatId: 'chat-a' });
	});
});
