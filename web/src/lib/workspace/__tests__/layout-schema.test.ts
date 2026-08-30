import { describe, expect, it } from 'vitest';
import {
	CANONICAL_CHAT_SURFACE_ID,
	CANONICAL_WINDOW_ID,
	canonicalWorkspaceSnapshot,
} from '../canonical-layout';
import { parsePersistedWorkspaceLayout, serializeWorkspaceLayout } from '../layout-schema';
import { portableSingletonDescriptor } from '../surface-types';
import { reduceWorkspaceLayout } from '../workspace-layout.svelte';
import { collectWindowNodes, windowNodeById } from '../window-tree';
import type { PersistedWorkspaceLayoutNode } from '$shared/workspace-layout';

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
