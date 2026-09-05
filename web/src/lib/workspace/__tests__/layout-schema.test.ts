import { describe, expect, it } from 'vitest';
import {
	CANONICAL_CHAT_SURFACE_ID,
	CANONICAL_WINDOW_ID,
	canonicalWorkspaceSnapshot,
} from '../canonical-layout';
import {
	parsePersistedWorkspaceLayout,
	serializeWorkspaceLayout,
	WORKSPACE_LAYOUT_MAX_PARSE_DEPTH,
	WORKSPACE_LAYOUT_MAX_PARSE_NODES,
	WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW,
} from '../layout-schema';
import { portableSingletonDescriptor } from '../surface-types';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { collectWindowNodes, windowNodeById } from '../window-tree';
import type {
	PersistedWorkspaceLayoutNode,
	PersistedWorkspaceSurfaceRef,
} from '$shared/workspace-layout';

function persistedWindow(index: number): PersistedWorkspaceLayoutNode {
	return {
		type: 'window',
		id: `window-budget-${index}`,
		order: [{ type: 'chat', chatId: `chat-budget-${index}` }],
		active: { type: 'chat', chatId: `chat-budget-${index}` },
		mru: [],
	};
}

function skewedTree(depth: number): PersistedWorkspaceLayoutNode {
	let root = persistedWindow(1);
	for (let level = 2; level <= depth; level += 1) {
		root = {
			type: 'partition',
			id: `partition-depth-${level}`,
			direction: 'horizontal',
			ratio: 0.5,
			children: [persistedWindow(level), root],
		};
	}
	return root;
}

function fullTreeWithNodes(nodeCount: number): PersistedWorkspaceLayoutNode {
	const leafCount = (nodeCount + 1) / 2;
	let level = Array.from({ length: leafCount }, (_, index) => persistedWindow(index + 1));
	let partitionIndex = 0;
	while (level.length > 1) {
		const next: PersistedWorkspaceLayoutNode[] = [];
		for (let index = 0; index < level.length; index += 2) {
			const first = level[index]!;
			const second = level[index + 1];
			if (!second) {
				next.push(first);
				continue;
			}
			partitionIndex += 1;
			next.push({
				type: 'partition',
				id: `partition-node-${partitionIndex}`,
				direction: 'horizontal',
				ratio: 0.5,
				children: [first, second],
			});
		}
		level = next;
	}
	return level[0]!;
}

describe('workspace layout V2 schema', () => {
	it('round-trips mixed window topology, local tab MRU, ratios, terminals, and Chat IDs', () => {
		const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{ type: 'set-window-chat', windowId: CANONICAL_WINDOW_ID, chatId: 'chat-a' },
			{
				type: 'register-surface',
				surface: portableSingletonDescriptor('git'),
				windowId: CANONICAL_WINDOW_ID,
			},
			{
				type: 'open-chat-in-new-window',
				chatId: 'chat-a',
				targetWindowId: CANONICAL_WINDOW_ID,
				edge: 'right',
				newWindowId: 'window-two',
				partitionId: 'partition-root',
			},
			{
				type: 'register-surface-in-new-window',
				surface: { id: 'terminal:t1', type: 'terminal', terminalId: 't1' },
				targetWindowId: 'window-two',
				edge: 'bottom',
				newWindowId: 'window-three',
				partitionId: 'partition-nested',
			},
			{ type: 'set-partition-ratio', partitionId: 'partition-root', ratio: 0.62 },
		]);
		const persisted = serializeWorkspaceLayout({
			...snapshot,
			fullscreenWindowId: 'window-two',
			unplacedTerminalIds: ['spare'],
		});
		const result = parsePersistedWorkspaceLayout(JSON.stringify(persisted));

		expect(result.source).toBe('valid');
		expect(serializeWorkspaceLayout(result.snapshot)).toEqual(persisted);
		expect(result.snapshot.surfaces[CANONICAL_CHAT_SURFACE_ID]).toMatchObject({ chatId: 'chat-a' });
		expect(result.snapshot.surfaces['chat-view:window-two']).toMatchObject({ chatId: 'chat-a' });
		expect(result.snapshot.unplacedTerminalIds).toEqual(['spare']);
		expect(result.snapshot.fullscreenWindowId).toBeNull();
	});

	it('restores a null Chat ID and keeps only the first Chat ref in a window', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'window',
					id: 'window-main',
					order: [
						{ type: 'chat', chatId: null },
						{ type: 'chat', chatId: 'ignored' },
						{ type: 'singleton', kind: 'git' },
					],
					active: { type: 'chat', chatId: 'ignored-active-value' },
					mru: [
						{ type: 'singleton', kind: 'git' },
						{ type: 'chat', chatId: 'ignored-mru-value' },
					],
				},
				unplacedTerminalIds: [],
			}),
		);

		expect(result.source).toBe('valid');
		expect(result.snapshot.surfaces[CANONICAL_CHAT_SURFACE_ID]).toEqual({
			id: CANONICAL_CHAT_SURFACE_ID,
			type: 'chat',
			chatId: null,
		});
		expect(windowNodeById(result.snapshot.desktopRoot, CANONICAL_WINDOW_ID)?.tabs).toEqual({
			order: [CANONICAL_CHAT_SURFACE_ID, 'singleton:git'],
			activeId: CANONICAL_CHAT_SURFACE_ID,
			mru: [CANONICAL_CHAT_SURFACE_ID, 'singleton:git'],
		});
	});

	it('deduplicates portable singletons and terminals globally while allowing duplicate chat records', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'partition',
					id: 'partition-root',
					direction: 'horizontal',
					ratio: 0.5,
					children: [
						{
							type: 'window',
							id: 'window-a',
							order: [
								{ type: 'chat', chatId: 'same' },
								{ type: 'singleton', kind: 'git' },
								{ type: 'terminal', terminalId: 't1' },
							],
							active: { type: 'chat', chatId: 'same' },
							mru: [],
						},
						{
							type: 'window',
							id: 'window-b',
							order: [
								{ type: 'chat', chatId: 'same' },
								{ type: 'singleton', kind: 'git' },
								{ type: 'terminal', terminalId: 't1' },
								{ type: 'singleton', kind: 'files' },
							],
							active: { type: 'singleton', kind: 'files' },
							mru: [],
						},
					],
				},
				unplacedTerminalIds: ['t1', 't2', 't2'],
			}),
		);

		expect(result.source).toBe('valid');
		expect(windowNodeById(result.snapshot.desktopRoot, 'window-a')?.tabs.order).toEqual([
			'chat-view:window-a',
			'singleton:git',
			'terminal:t1',
		]);
		expect(windowNodeById(result.snapshot.desktopRoot, 'window-b')?.tabs.order).toEqual([
			'chat-view:window-b',
			'singleton:files',
		]);
		expect(result.snapshot.unplacedTerminalIds).toEqual(['t2']);
	});

	it('round-trips and globally deduplicates the Chat Map singleton', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'partition',
					id: 'partition-root',
					direction: 'horizontal',
					ratio: 0.5,
					children: [
						{
							type: 'window',
							id: 'window-a',
							order: [
								{ type: 'chat', chatId: 'chat-a' },
								{ type: 'singleton', kind: 'chat-map' },
							],
							active: { type: 'singleton', kind: 'chat-map' },
							mru: [],
						},
						{
							type: 'window',
							id: 'window-b',
							order: [
								{ type: 'chat', chatId: 'chat-b' },
								{ type: 'singleton', kind: 'chat-map' },
							],
							active: { type: 'chat', chatId: 'chat-b' },
							mru: [],
						},
					],
				},
				unplacedTerminalIds: [],
			}),
		);

		expect(result.source).toBe('valid');
		expect(windowNodeById(result.snapshot.desktopRoot, 'window-a')?.tabs.order).toContain(
			'singleton:chat-map',
		);
		expect(windowNodeById(result.snapshot.desktopRoot, 'window-b')?.tabs.order).not.toContain(
			'singleton:chat-map',
		);
		expect(serializeWorkspaceLayout(result.snapshot).root).toMatchObject({
			type: 'partition',
		});
		expect(JSON.stringify(serializeWorkspaceLayout(result.snapshot))).toContain('chat-map');
	});

	it('repairs invalid active and MRU refs, clamps ratios, and collapses empty branches', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'partition',
					id: 'partition-root',
					direction: 'horizontal',
					ratio: 9,
					children: [
						{
							type: 'window',
							id: 'window-main',
							order: [
								{ type: 'chat', chatId: 'a' },
								{ type: 'singleton', kind: 'git' },
							],
							active: { type: 'terminal', terminalId: 'missing' },
							mru: [
								{ type: 'singleton', kind: 'git' },
								{ type: 'singleton', kind: 'git' },
								{ type: 'terminal', terminalId: 'missing' },
							],
						},
						{
							type: 'window',
							id: 'window-empty',
							order: [{ type: 'unknown' }],
							active: null,
							mru: [],
						},
					],
				},
				unplacedTerminalIds: [],
			}),
		);

		expect(result.source).toBe('valid');
		expect(result.snapshot.desktopRoot.type).toBe('window');
		const root = result.snapshot.desktopRoot;
		if (root.type !== 'window') throw new Error('Expected collapsed window');
		expect(root.tabs.activeId).toBe('chat-view:window-main');
		expect(root.tabs.mru).toEqual(['chat-view:window-main', 'singleton:git']);
	});

	it('caps malformed oversized topology without moving window-owned Chat views', () => {
		const windows: PersistedWorkspaceLayoutNode[] = [
			{
				type: 'window',
				id: 'window-1',
				order: [{ type: 'singleton', kind: 'git' }],
				active: { type: 'singleton', kind: 'git' },
				mru: [],
			},
			...Array.from({ length: 3 }, (_, index) => ({
				type: 'window' as const,
				id: `window-${index + 2}`,
				order: [{ type: 'chat' as const, chatId: `chat-${index + 2}` }],
				active: { type: 'chat' as const, chatId: `chat-${index + 2}` },
				mru: [],
			})),
			{
				type: 'window',
				id: 'window-5',
				order: [
					{ type: 'chat', chatId: 'chat-5' },
					{ type: 'terminal', terminalId: 'terminal-5' },
				],
				active: { type: 'chat', chatId: 'chat-5' },
				mru: [{ type: 'terminal', terminalId: 'terminal-5' }],
			},
		];
		const root = windows.slice(1).reduce<PersistedWorkspaceLayoutNode>(
			(first, second, index) => ({
				type: 'partition',
				id: `partition-${index + 1}`,
				direction: 'horizontal',
				ratio: 0.5,
				children: [first, second],
			}),
			windows[0]!,
		);
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({ version: 2, root, unplacedTerminalIds: [] }),
		);
		expect(result.source).toBe('valid');
		expect(collectWindowNodes(result.snapshot.desktopRoot)).toHaveLength(4);
		expect(windowNodeById(result.snapshot.desktopRoot, 'window-1')?.tabs.order).toEqual([
			'singleton:git',
			'terminal:terminal-5',
		]);
		expect(
			Object.values(result.snapshot.surfaces).filter((surface) => surface.type === 'chat'),
		).toHaveLength(3);
		expect(result.snapshot.surfaces['chat-view:window-5']).toBeUndefined();
	});

	it('accepts the maximum restore depth and falls back one level beyond it', () => {
		const accepted = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: skewedTree(WORKSPACE_LAYOUT_MAX_PARSE_DEPTH),
				unplacedTerminalIds: [],
			}),
		);
		expect(accepted.source).toBe('valid');

		const rejected = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: skewedTree(WORKSPACE_LAYOUT_MAX_PARSE_DEPTH + 1),
				unplacedTerminalIds: [],
			}),
		);
		expect(rejected).toEqual({ source: 'fallback', snapshot: canonicalWorkspaceSnapshot() });
	});

	it('bounds total restored nodes before resource-ceiling repair', () => {
		const largestFullTreeBelowBudget = WORKSPACE_LAYOUT_MAX_PARSE_NODES - 1;
		const accepted = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: fullTreeWithNodes(largestFullTreeBelowBudget),
				unplacedTerminalIds: [],
			}),
		);
		expect(accepted.source).toBe('valid');
		expect(collectWindowNodes(accepted.snapshot.desktopRoot)).toHaveLength(4);

		const firstFullTreeAboveBudget = WORKSPACE_LAYOUT_MAX_PARSE_NODES + 1;
		const rejected = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: fullTreeWithNodes(firstFullTreeAboveBudget),
				unplacedTerminalIds: [],
			}),
		);
		expect(rejected).toEqual({ source: 'fallback', snapshot: canonicalWorkspaceSnapshot() });
	});

	it.each(['order', 'mru'] as const)(
		'accepts the per-window %s budget and truncates the next reference',
		(field) => {
			const refs: PersistedWorkspaceSurfaceRef[] = Array.from(
				{ length: WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW },
				(_, index) =>
					index === 0
						? { type: 'chat', chatId: 'chat-budget' }
						: { type: 'terminal', terminalId: `terminal-budget-${index}` },
			);
			const root = {
				type: 'window' as const,
				id: 'window-main',
				order: refs,
				active: refs[0],
				mru: field === 'mru' ? refs : [],
			};

			const accepted = parsePersistedWorkspaceLayout(
				JSON.stringify({ version: 2, root, unplacedTerminalIds: [] }),
			);
			expect(accepted.source).toBe('valid');

			const oversizedRoot = {
				...root,
				[field]: [...refs, { type: 'terminal', terminalId: 'terminal-over-budget' }],
			};
			const truncated = parsePersistedWorkspaceLayout(
				JSON.stringify({ version: 2, root: oversizedRoot, unplacedTerminalIds: [] }),
			);
			expect(truncated.source).toBe('valid');
			const restoredWindow = windowNodeById(truncated.snapshot.desktopRoot, 'window-main');
			expect(restoredWindow?.tabs.order).toHaveLength(WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW);
			expect(restoredWindow?.tabs.mru).toHaveLength(WORKSPACE_LAYOUT_MAX_TABS_PER_WINDOW);
			expect(truncated.snapshot.surfaces['terminal:terminal-over-budget']).toBeUndefined();
		},
	);

	it('falls back for malformed current roots and unsupported versions', () => {
		for (const raw of [
			{ version: 2, root: null, unplacedTerminalIds: [] },
			{ version: 3, root: null },
		]) {
			const result = parsePersistedWorkspaceLayout(JSON.stringify(raw));
			expect(result.source).toBe('fallback');
			expect(result.snapshot).toEqual(canonicalWorkspaceSnapshot());
		}
	});

	it('falls back when restored topology has no Chat view', () => {
		const result = parsePersistedWorkspaceLayout(
			JSON.stringify({
				version: 2,
				root: {
					type: 'window',
					id: 'window-main',
					order: [{ type: 'singleton', kind: 'git' }],
					active: { type: 'singleton', kind: 'git' },
					mru: [],
				},
				unplacedTerminalIds: [],
			}),
		);

		expect(result.source).toBe('fallback');
		expect(result.snapshot).toEqual(canonicalWorkspaceSnapshot());
	});

	it('omits fullscreen, files, dialog, mobile, and focus projections from serialization', () => {
		const fileSnapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
			{
				type: 'register-surface',
				surface: { id: 'file:f1', type: 'file', fileSessionId: 'f1' },
				windowId: CANONICAL_WINDOW_ID,
			},
		]);
		const value = serializeWorkspaceLayout({
			...fileSnapshot,
			fullscreenWindowId: CANONICAL_WINDOW_ID,
			dialogFileSurfaceId: 'file:f1',
			mobileActiveSurfaceId: 'file:f1',
			mobileOnlySurfaceIds: ['file:f1'],
		});
		const serialized = JSON.stringify(value);
		expect(serialized).not.toContain('fullscreen');
		expect(serialized).not.toContain('dialog');
		expect(serialized).not.toContain('mobile');
		expect(serialized).not.toContain('file:f1');
	});

	it('uses the one-Chat-window canonical layout when storage is absent', () => {
		const result = parsePersistedWorkspaceLayout(null);
		expect(result).toEqual({ source: 'absent', snapshot: canonicalWorkspaceSnapshot() });
	});
});
