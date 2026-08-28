import { describe, expect, it } from 'vitest';
import { parsePersistedWorkspaceLayout, serializeWorkspaceLayout } from '../layout-schema';
import { canonicalWorkspaceSnapshot } from '../canonical-layout';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { collectPaneNodes, paneNodeById } from '../pane-tree';
import type { PaneId, WorkspaceLayoutSnapshot } from '../surface-types';

function paneTabs(snapshot: WorkspaceLayoutSnapshot, paneId: string) {
	return paneNodeById(snapshot.desktopRoot, paneId as PaneId)?.tabs;
}

describe('workspace layout persistence', () => {
	it('distinguishes absent data from corrupt fallback', () => {
		expect(parsePersistedWorkspaceLayout(null).source).toBe('absent');
		expect(parsePersistedWorkspaceLayout('{').source).toBe('fallback');
		expect(parsePersistedWorkspaceLayout('{"version":1}').source).toBe('fallback');
		expect(parsePersistedWorkspaceLayout('{"version":3}').source).toBe('fallback');
	});

	it('round-trips a pane tree', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface-in-split',
				surface: { id: 'terminal:abc', type: 'terminal', terminalId: 'abc' },
				targetPaneId: 'pane-main',
				edge: 'right',
				newPaneId: 'pane-2',
				splitId: 'split-1',
			},
			{ type: 'set-split-ratio', splitId: 'split-1', ratio: 0.7 },
			{
				type: 'activate-pane-tab',
				paneId: 'pane-main',
				surfaceId: 'singleton:pull-requests',
			},
			{ type: 'activate-pane-tab', paneId: 'pane-main', surfaceId: 'singleton:git' },
		]);
		const restored = parsePersistedWorkspaceLayout(
			JSON.stringify(serializeWorkspaceLayout(base)),
		);
		expect(restored.source).toBe('valid');
		expect(restored.snapshot.desktopRoot).toEqual(base.desktopRoot);
		expect(restored.snapshot.surfaces).toEqual(base.surfaces);
		expect(paneTabs(restored.snapshot, 'pane-main')?.mru).toEqual([
			'singleton:git',
			'singleton:pull-requests',
			'singleton:chat',
		]);
	});

	it('restores chat when the persisted tree lacks it', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'pane',
					id: 'pane-a',
					order: [{ type: 'singleton', kind: 'git' }],
					active: { type: 'singleton', kind: 'git' },
				},
				unplacedTerminalIds: [],
			}),
		);
		expect(result.source).toBe('valid');
		expect(paneTabs(result.snapshot, 'pane-a')?.order).toEqual(['singleton:chat', 'singleton:git']);
		expect(paneTabs(result.snapshot, 'pane-a')?.activeId).toBe('singleton:git');
	});

	it('drops panes with no durable tabs and collapses their splits', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'split',
					id: 'split-1',
					direction: 'horizontal',
					ratio: 0.5,
					children: [
						{
							type: 'pane',
							id: 'pane-a',
							order: [{ type: 'singleton', kind: 'chat' }],
							active: { type: 'singleton', kind: 'chat' },
						},
						{ type: 'pane', id: 'pane-b', order: [], active: null },
					],
				},
				unplacedTerminalIds: [],
			}),
		);
		expect(result.source).toBe('valid');
		expect(result.snapshot.desktopRoot.type).toBe('pane');
		expect(collectPaneNodes(result.snapshot.desktopRoot)).toHaveLength(1);
	});

	it('deduplicates surfaces across panes and repairs invalid active refs', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'split',
					id: 'split-1',
					direction: 'horizontal',
					ratio: 0.5,
					children: [
						{
							type: 'pane',
							id: 'pane-a',
							order: [
								{ type: 'singleton', kind: 'chat' },
								{ type: 'singleton', kind: 'git' },
								{ type: 'singleton', kind: 'unknown' },
							],
							active: { type: 'singleton', kind: 'files' },
						},
						{
							type: 'pane',
							id: 'pane-b',
							order: [
								{ type: 'singleton', kind: 'git' },
								{ type: 'singleton', kind: 'files' },
							],
							active: { type: 'singleton', kind: 'git' },
						},
					],
				},
				unplacedTerminalIds: [],
			}),
		);
		expect(result.source).toBe('valid');
		expect(paneTabs(result.snapshot, 'pane-a')?.order).toEqual(['singleton:chat', 'singleton:git']);
		expect(paneTabs(result.snapshot, 'pane-a')?.activeId).toBe('singleton:chat');
		expect(paneTabs(result.snapshot, 'pane-b')?.order).toEqual(['singleton:files']);
		expect(paneTabs(result.snapshot, 'pane-b')?.activeId).toBe('singleton:files');
	});

	it('clamps out-of-range ratios', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'split',
					id: 'split-1',
					direction: 'horizontal',
					ratio: 0.99,
					children: [
						{
							type: 'pane',
							id: 'pane-a',
							order: [{ type: 'singleton', kind: 'chat' }],
							active: { type: 'singleton', kind: 'chat' },
						},
						{
							type: 'pane',
							id: 'pane-b',
							order: [{ type: 'singleton', kind: 'git' }],
							active: { type: 'singleton', kind: 'git' },
						},
					],
				},
				unplacedTerminalIds: [],
			}),
		);
		expect(result.source).toBe('valid');
		const root = result.snapshot.desktopRoot;
		expect(root.type === 'split' && root.ratio).toBe(0.85);
	});

	it('migrates an open v1 sidebar into a second pane', () => {
		const result = parsePersistedWorkspaceLayout(
			null,
			JSON.stringify({
				version: 1,
				desiredSidebarWidth: 480,
				sidebarOpen: true,
				main: {
					order: [
						{ type: 'singleton', kind: 'git' },
						{ type: 'terminal', terminalId: 'server-terminal' },
					],
					active: { type: 'singleton', kind: 'git' },
				},
				sidebar: {
					order: [{ type: 'singleton', kind: 'files' }],
					active: { type: 'singleton', kind: 'files' },
				},
				unplacedTerminalIds: [],
			}),
		);
		expect(result.source).toBe('migrated');
		expect(collectPaneNodes(result.snapshot.desktopRoot)).toHaveLength(2);
		expect(paneTabs(result.snapshot, 'pane-main')?.order).toEqual([
			'singleton:chat',
			'singleton:git',
			'terminal:server-terminal',
		]);
		expect(paneTabs(result.snapshot, 'pane-main')?.activeId).toBe('singleton:git');
		expect(paneTabs(result.snapshot, 'pane-sidebar')?.order).toEqual(['singleton:files']);
		const root = result.snapshot.desktopRoot;
		expect(root.type === 'split' && root.direction).toBe('horizontal');
	});

	it('merges a closed v1 sidebar into the main pane', () => {
		const result = parsePersistedWorkspaceLayout(
			null,
			JSON.stringify({
				version: 1,
				desiredSidebarWidth: 480,
				sidebarOpen: false,
				main: {
					order: [{ type: 'singleton', kind: 'git' }],
					active: { type: 'singleton', kind: 'git' },
				},
				sidebar: {
					order: [
						{ type: 'singleton', kind: 'files' },
						{ type: 'singleton', kind: 'commit' },
					],
					active: { type: 'singleton', kind: 'commit' },
				},
				unplacedTerminalIds: [],
			}),
		);
		expect(result.source).toBe('migrated');
		expect(collectPaneNodes(result.snapshot.desktopRoot)).toHaveLength(1);
		expect(paneTabs(result.snapshot, 'pane-main')?.order).toEqual([
			'singleton:chat',
			'singleton:git',
			'singleton:files',
			'singleton:commit',
		]);
		expect(paneTabs(result.snapshot, 'pane-main')?.activeId).toBe('singleton:git');
	});

	it('preserves unplaced terminal ids through migration', () => {
		const result = parsePersistedWorkspaceLayout(
			null,
			JSON.stringify({
				version: 1,
				desiredSidebarWidth: 480,
				sidebarOpen: false,
				main: { order: [], active: null },
				sidebar: { order: [], active: null },
				unplacedTerminalIds: ['detached-terminal'],
			}),
		);
		expect(result.source).toBe('migrated');
		expect(result.snapshot.unplacedTerminalIds).toEqual(['detached-terminal']);
	});

	it('serializes only durable surface references', () => {
		const base = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:session-1', type: 'file', fileSessionId: 'session-1' },
				paneId: 'pane-main',
			},
		]);
		const serialized = serializeWorkspaceLayout(base);
		const root = serialized.root;
		if (root.type !== 'pane') throw new Error('expected pane root');
		expect(root.order).toEqual([
			{ type: 'singleton', kind: 'chat' },
			{ type: 'singleton', kind: 'git' },
			{ type: 'singleton', kind: 'pull-requests' },
		]);
	});
});
