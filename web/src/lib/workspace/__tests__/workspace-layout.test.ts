import { describe, expect, it } from 'vitest';
import {
	WorkspaceLayoutStore,
	assertWorkspaceLayoutInvariants,
	reduceWorkspaceLayout,
} from '../workspace-layout.svelte';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import type { SurfaceDescriptor, WorkspaceLayoutSnapshot } from '../surface-types';

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

describe('workspace layout reducers', () => {
	it('creates the canonical first-run layout', () => {
		const snapshot = canonicalWorkspaceSnapshot();

		expect(snapshot.main.order).toEqual([
			'singleton:chat',
			'singleton:git',
			'singleton:pull-requests',
		]);
		expect(snapshot.sidebar.order).toEqual(['singleton:files', 'singleton:commit']);
		expect(snapshot.sidebarOpen).toBe(true);
		expect(snapshot.desiredSidebarWidth).toBe(480);
		expect(() => assertWorkspaceLayoutInvariants(snapshot)).not.toThrow();
	});

	it('focuses host surfaces and preserves MRU fallback order', () => {
		const focused = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:pull-requests' },
		]);

		expect(focused.main.activeId).toBe('singleton:pull-requests');
		expect(focused.main.mru).toEqual([
			'singleton:pull-requests',
			'singleton:git',
			'singleton:chat',
		]);

		const closed = reduceWorkspaceLayout(focused, [
			{ type: 'remove-surface', surfaceId: 'singleton:pull-requests' },
		]);
		expect(closed.main.activeId).toBe('singleton:git');
	});

	it('does not manufacture focus recency when registering or assigning a surface', () => {
		const focused = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);
		const registered = reduceWorkspaceLayout(focused, [
			{ type: 'register-surface', surface: TERMINAL_A, host: 'main' },
		]);

		expect(registered.main.activeId).toBe('singleton:git');
		expect(registered.main.mru).toEqual([
			'singleton:git',
			'singleton:chat',
			'singleton:pull-requests',
			TERMINAL_A.id,
		]);

		const mobileOnly = reduceWorkspaceLayout(registered, [
			{ type: 'register-surface', surface: FILE_A },
		]);
		const assigned = reduceWorkspaceLayout(mobileOnly, [
			{ type: 'assign-to-host', surfaceId: FILE_A.id, destination: 'main' },
		]);
		expect(assigned.main.activeId).toBe('singleton:git');
		expect(assigned.main.mru.at(-1)).toBe(FILE_A.id);

		const activated = reduceWorkspaceLayout(assigned, [
			{ type: 'focus-host', host: 'main', surfaceId: FILE_A.id },
		]);
		expect(activated.main.mru[0]).toBe(FILE_A.id);
	});

	it('moves one surface without duplicating or destroying it', () => {
		const moved = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'move-to-host', surfaceId: 'singleton:git', destination: 'sidebar', index: 0 },
		]);

		expect(moved.main.order).not.toContain('singleton:git');
		expect(moved.sidebar.order[0]).toBe('singleton:git');
		expect(moved.sidebar.activeId).toBe('singleton:git');
		expect(moved.sidebarOpen).toBe(true);
		expect(moved.surfaces['singleton:git']).toBeDefined();
	});

	it('closes an emptied sidebar after moving its last tab', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'remove-surface', surfaceId: 'singleton:commit' },
			{ type: 'set-sidebar-open', open: true },
		]);
		const moved = reduceWorkspaceLayout(base, [
			{ type: 'move-to-host', surfaceId: 'singleton:files', destination: 'main' },
		]);

		expect(moved.sidebar.order).toEqual([]);
		expect(moved.sidebarOpen).toBe(false);
		expect(moved.main.activeId).toBe('singleton:files');
	});

	it('does not open a sidebar without any tabs', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'remove-surface', surfaceId: 'singleton:commit' },
			{ type: 'remove-surface', surfaceId: 'singleton:files' },
		]);
		const next = reduceWorkspaceLayout(base, [{ type: 'set-sidebar-open', open: true }]);

		expect(next.sidebar.order).toEqual([]);
		expect(next.sidebarOpen).toBe(false);
		expect(() => assertWorkspaceLayoutInvariants({ ...next, sidebarOpen: true })).toThrow(
			'Empty sidebar cannot be open',
		);
	});

	it('registers host and mobile-only surfaces with exclusive ownership', () => {
		const next = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: TERMINAL_A, host: 'main' },
			{ type: 'register-surface', surface: FILE_A },
			{
				type: 'set-mobile-presentation',
				activeId: FILE_A.id,
				returnStack: [],
			},
		]);

		expect(next.main.order).toContain(TERMINAL_A.id);
		expect(next.mobileOnlySurfaceIds).toEqual([FILE_A.id]);
		expect(next.mobileActiveSurfaceId).toBe(FILE_A.id);
		expect(() => assertWorkspaceLayoutInvariants(next)).not.toThrow();
	});

	it('rejects terminal and launcher registrations without a host', () => {
		expect(() =>
			reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
				{ type: 'register-surface', surface: TERMINAL_A },
			]),
		).toThrow('Only file and portable singleton surfaces may be mobile-only');
	});

	it('tracks intentionally unplaced terminals until they are reopened or forgotten', () => {
		const unplaced = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: TERMINAL_A, host: 'main' },
			{ type: 'unplace-terminal', terminalId: TERMINAL_A.terminalId },
		]);

		expect(unplaced.surfaces[TERMINAL_A.id]).toBeUndefined();
		expect(unplaced.unplacedTerminalIds).toEqual([TERMINAL_A.terminalId]);

		const reopened = reduceWorkspaceLayout(unplaced, [
			{ type: 'register-surface', surface: TERMINAL_A, host: 'sidebar' },
		]);
		expect(reopened.unplacedTerminalIds).toEqual([]);

		const forgotten = reduceWorkspaceLayout(unplaced, [
			{ type: 'forget-terminal', terminalId: TERMINAL_A.terminalId },
		]);
		expect(forgotten.unplacedTerminalIds).toEqual([]);
	});

	it('moves files through host and exclusive dialog placement', () => {
		const inDialog = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: FILE_A, host: 'main' },
			{ type: 'place-in-dialog', surfaceId: FILE_A.id },
		]);

		expect(inDialog.dialogFileSurfaceId).toBe(FILE_A.id);
		expect(inDialog.main.order).not.toContain(FILE_A.id);

		const inSidebar = reduceWorkspaceLayout(inDialog, [
			{ type: 'move-dialog-to-host', surfaceId: FILE_A.id, destination: 'sidebar' },
		]);
		expect(inSidebar.dialogFileSurfaceId).toBeNull();
		expect(inSidebar.sidebar.activeId).toBe(FILE_A.id);
		expect(inSidebar.sidebarOpen).toBe(true);
	});

	it('atomically replaces the terminal launcher at its exact position', () => {
		const launcher: SurfaceDescriptor = {
			id: 'terminal-launcher',
			type: 'terminal-launcher',
		};
		const next = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: launcher, host: 'main', index: 1 },
			{ type: 'focus-host', host: 'main', surfaceId: launcher.id },
			{ type: 'replace-surface', previousId: launcher.id, surface: TERMINAL_A },
		]);

		expect(next.main.order[1]).toBe(TERMINAL_A.id);
		expect(next.main.activeId).toBe(TERMINAL_A.id);
		expect(next.surfaces[launcher.id]).toBeUndefined();
	});

	it('swaps two terminal sessions without adding or removing a tab', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: TERMINAL_A, host: 'main' },
			{ type: 'focus-host', host: 'main', surfaceId: TERMINAL_A.id },
			{ type: 'register-surface', surface: TERMINAL_B, host: 'sidebar' },
			{ type: 'focus-host', host: 'sidebar', surfaceId: TERMINAL_B.id },
		]);
		const next = reduceWorkspaceLayout(base, [
			{
				type: 'swap-terminal-placements',
				firstSurfaceId: TERMINAL_A.id,
				secondSurfaceId: TERMINAL_B.id,
			},
		]);

		expect(next.main.order).toContain(TERMINAL_B.id);
		expect(next.main.order).not.toContain(TERMINAL_A.id);
		expect(next.sidebar.order).toContain(TERMINAL_A.id);
		expect(next.main.activeId).toBe(TERMINAL_B.id);
		expect(next.sidebar.activeId).toBe(TERMINAL_A.id);
		expect(Object.keys(next.surfaces)).toEqual(Object.keys(base.surfaces));
	});

	it('marks the previous terminal unplaced when replacing a tab session', () => {
		const next = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: TERMINAL_A, host: 'main' },
			{ type: 'unplace-terminal', terminalId: TERMINAL_B.terminalId },
			{ type: 'replace-surface', previousId: TERMINAL_A.id, surface: TERMINAL_B },
		]);

		expect(next.main.order).toContain(TERMINAL_B.id);
		expect(next.unplacedTerminalIds).toEqual([TERMINAL_A.terminalId]);
	});

	it('bounds and deduplicates mobile return targets', () => {
		const stack = Array.from({ length: 40 }, (_, index) => ({
			invokerSurfaceId: `file:${index}`,
			invokerHost: 'mobile' as const,
			chatId: null,
			effectiveProjectKey: null,
			routeIdentity: `/chat/${index}`,
		}));
		stack.push({ ...stack[39] });
		const next = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-mobile-presentation', activeId: 'singleton:chat', returnStack: stack },
		]);

		expect(next.mobileReturnStack).toHaveLength(32);
		expect(next.mobileReturnStack.at(-1)).toEqual(stack[39]);
	});

	it('does not mutate reducer inputs', () => {
		const base = canonicalWorkspaceSnapshot();
		const before = structuredClone(base);
		const next = reduceWorkspaceLayout(base, [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);

		expect(base).toEqual(before);
		expect(next).not.toBe(base);
		expect(next.main).not.toBe(base.main);
	});

	it('rejects invariant-invalid snapshots', () => {
		const base = canonicalWorkspaceSnapshot();
		const invalid: WorkspaceLayoutSnapshot = {
			...base,
			main: { ...base.main, order: ['singleton:git', ...base.main.order] },
		};

		expect(() => assertWorkspaceLayoutInvariants(invalid)).toThrow(
			'Chat must exist exactly once at the start of main',
		);
	});
});

describe('WorkspaceLayoutStore', () => {
	it('publishes one frozen whole snapshot per matching revision', () => {
		const store = new WorkspaceLayoutStore();
		const next = reduceWorkspaceLayout(store.snapshot, [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);

		expect(store.publish(0, next)).toBe(true);
		expect(store.revision).toBe(1);
		expect(store.snapshot).toBe(next);
		expect(Object.isFrozen(store.snapshot)).toBe(true);
		expect(Object.isFrozen(store.snapshot.main.order)).toBe(true);
		expect(store.activeMainKind).toBe('git');
	});

	it('rejects stale publishes without changing state', () => {
		const store = new WorkspaceLayoutStore();
		const original = store.snapshot;
		const next = reduceWorkspaceLayout(original, [
			{ type: 'focus-host', host: 'main', surfaceId: 'singleton:git' },
		]);

		expect(store.publish(1, next)).toBe(false);
		expect(store.snapshot).toBe(original);
		expect(store.revision).toBe(0);
	});

	it.each([
		['singleton:chat', 'chat'],
		['singleton:git', 'git'],
		['singleton:pull-requests', 'pull-requests'],
		['singleton:files', 'files'],
		['singleton:commit', 'commit'],
	] as const)('reports active kind for %s', (surfaceId, kind) => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'focus-host',
				host:
					surfaceId === 'singleton:files' || surfaceId === 'singleton:commit' ? 'sidebar' : 'main',
				surfaceId,
			},
			...(surfaceId === 'singleton:files' || surfaceId === 'singleton:commit'
				? [{ type: 'move-to-host' as const, surfaceId, destination: 'main' as const }]
				: []),
		]);
		const store = new WorkspaceLayoutStore(base);

		expect(store.activeMainKind).toBe(kind);
	});

	it.each([
		[TERMINAL_A, 'terminal'],
		[FILE_A, 'file'],
		[{ id: 'terminal-launcher', type: 'terminal-launcher' } as const, 'terminal-launcher'],
	] as const)('reports dynamic active kind', (surface, kind) => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface, host: 'main' },
			{ type: 'focus-host', host: 'main', surfaceId: surface.id },
		]);

		expect(new WorkspaceLayoutStore(snapshot).activeMainKind).toBe(kind);
	});
});
