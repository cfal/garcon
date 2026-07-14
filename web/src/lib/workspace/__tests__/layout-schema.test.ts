import { describe, expect, it } from 'vitest';
import { parsePersistedWorkspaceLayout, serializeWorkspaceLayout } from '../layout-schema';
import {
	canonicalWorkspaceSnapshot,
	reduceWorkspaceLayout,
} from '$lib/stores/workspace-layout.svelte';

describe('workspace layout persistence', () => {
	it('distinguishes absent data from corrupt fallback', () => {
		expect(parsePersistedWorkspaceLayout(null).source).toBe('absent');
		expect(parsePersistedWorkspaceLayout('{').source).toBe('fallback');
		expect(parsePersistedWorkspaceLayout('{"version":2}').source).toBe('fallback');
	});

	it('injects Chat and restores valid singleton and unresolved terminal references', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 1,
				desiredSidebarWidth: 520,
				sidebarOpen: true,
				main: {
					order: [
						{ type: 'terminal', terminalId: 'server-terminal' },
						{ type: 'singleton', kind: 'git' },
					],
					active: { type: 'terminal', terminalId: 'server-terminal' },
				},
				sidebar: {
					order: [{ type: 'singleton', kind: 'files' }],
					active: { type: 'singleton', kind: 'files' },
				},
			}),
		);

		expect(result.source).toBe('valid');
		expect(result.snapshot.main.order).toEqual([
			'singleton:chat',
			'terminal:server-terminal',
			'singleton:git',
		]);
		expect(result.snapshot.main.activeId).toBe('terminal:server-terminal');
		expect(result.snapshot.sidebar.activeId).toBe('singleton:files');
		expect(result.snapshot.sidebarOpen).toBe(true);
	});

	it('repairs duplicates, unknown refs, invalid active values, and widths', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 1,
				desiredSidebarWidth: -100,
				sidebarOpen: true,
				main: {
					order: [
						{ type: 'singleton', kind: 'git' },
						{ type: 'singleton', kind: 'git' },
						{ type: 'singleton', kind: 'unknown' },
					],
					active: { type: 'singleton', kind: 'files' },
				},
				sidebar: {
					order: [
						{ type: 'singleton', kind: 'git' },
						{ type: 'singleton', kind: 'files' },
					],
					active: { type: 'singleton', kind: 'git' },
				},
			}),
		);

		expect(result.source).toBe('valid');
		expect(result.snapshot.main.order).toEqual(['singleton:chat', 'singleton:git']);
		expect(result.snapshot.main.activeId).toBe('singleton:chat');
		expect(result.snapshot.sidebar.order).toEqual(['singleton:files']);
		expect(result.snapshot.sidebar.activeId).toBe('singleton:files');
		expect(result.snapshot.desiredSidebarWidth).toBe(360);
	});

	it('restores an intentionally open empty sidebar host', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 1,
				desiredSidebarWidth: 480,
				sidebarOpen: true,
				main: { order: [], active: null },
				sidebar: { order: [], active: null },
			}),
		);

		expect(result.source).toBe('valid');
		expect(result.snapshot.sidebar.order).toEqual([]);
		expect(result.snapshot.sidebarOpen).toBe(true);
	});

	it('serializes only singleton and terminal placement data', () => {
		const file = { id: 'file:a', type: 'file' as const, fileSessionId: 'a' };
		const terminal = { id: 'terminal:a', type: 'terminal' as const, terminalId: 'a' };
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: file, host: 'main' },
			{ type: 'place-in-dialog', surfaceId: file.id },
			{ type: 'register-surface', surface: terminal, host: 'main' },
			{ type: 'focus-host', host: 'main', surfaceId: terminal.id },
			{ type: 'set-manual-fullscreen', enabled: true },
		]);
		const serialized = serializeWorkspaceLayout(snapshot);

		expect(serialized.main.order).toEqual([
			{ type: 'singleton', kind: 'git' },
			{ type: 'singleton', kind: 'pull-requests' },
			{ type: 'terminal', terminalId: 'a' },
		]);
		expect(serialized.main.active).toEqual({ type: 'terminal', terminalId: 'a' });
		expect(JSON.stringify(serialized)).not.toContain('file:a');
		expect(JSON.stringify(serialized)).not.toContain('manualFullscreen');
	});

	it('round-trips intentionally unplaced terminal sessions', () => {
		const terminal = { id: 'terminal:a', type: 'terminal' as const, terminalId: 'a' };
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'register-surface', surface: terminal, host: 'main' },
			{ type: 'unplace-terminal', terminalId: terminal.terminalId },
		]);

		const serialized = serializeWorkspaceLayout(snapshot);
		const restored = parsePersistedWorkspaceLayout(JSON.stringify(serialized));

		expect(serialized.unplacedTerminalIds).toEqual(['a']);
		expect(restored.source).toBe('valid');
		expect(restored.snapshot.unplacedTerminalIds).toEqual(['a']);
		expect(restored.snapshot.surfaces[terminal.id]).toBeUndefined();
	});
});
