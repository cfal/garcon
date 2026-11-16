import { describe, expect, it } from 'vitest';
import { buildSidebarRowModel } from '../sidebar-row-model';
import type { SidebarTreeContinuation, SidebarVirtualRow } from '../sidebar-virtual-chat-list';
import { chat, delegated, projectionInput } from './sidebar-fixtures';

function guides(rows: SidebarVirtualRow[]) {
	return rows.map((row) => {
		const rails: number[] = [];
		for (let rail = row.tree?.continuations; rail; rail = rail.outer) rails.push(rail.depth);
		return [row.key, row.depth, row.tree?.parentDepth, row.tree?.isLastChild, rails];
	});
}

describe('delegated sidebar tree guides', () => {
	it('continues ancestor rails only through siblings that follow in display order', () => {
		const chats = [
			chat('root'),
			delegated('a', 'root'),
			delegated('a1', 'a'),
			delegated('a2', 'a'),
			delegated('b', 'root'),
			delegated('b1', 'b'),
			chat('plain'),
		];
		expect(guides(buildSidebarRowModel(projectionInput(chats)).rows)).toEqual([
			['chat:root', 0, undefined, undefined, []],
			['chat:a', 1, 0, false, []],
			['chat:a1', 2, 1, false, [0]],
			['chat:a2', 2, 1, true, [0]],
			['chat:b', 1, 0, true, []],
			['chat:b1', 2, 1, true, []],
			['chat:plain', 0, undefined, undefined, []],
		]);
	});

	it.each([false, true])(
		'leaves standalone and root-grouped rows undecorated (nest: %s)',
		(nest) => {
			const chats = [
				chat('root'),
				chat('plain'),
				delegated('orphan', 'missing'),
				chat('fork', {
					parentChat: {
						chatId: 'root',
						relation: 'fork',
						transcriptViewId: 'synthetic-view',
						ordinal: 0,
					},
				}),
			];
			const rows = buildSidebarRowModel(
				projectionInput(chats, {
					nestDelegatedChats: nest,
					groupingFields: [{ field: 'project', enabled: true }],
				}),
			).rows;
			expect(rows.every((row) => row.tree === undefined)).toBe(true);
			const flat = buildSidebarRowModel(
				projectionInput([...chats, delegated('child', 'root')], {
					nestDelegatedChats: false,
				}),
			);
			expect(flat.rows.every((row) => row.tree === undefined)).toBe(true);
		},
	);

	it('connects internal headers without connecting root headers or omitted inherited headers', () => {
		const chats = [
			chat('root'),
			delegated('a', 'root', { projectPath: '/a' }),
			delegated('a1', 'a', { projectPath: '/a' }),
			delegated('b', 'root', { projectPath: '/b' }),
		];
		const rows = buildSidebarRowModel(
			projectionInput(chats, {
				groupingFields: [{ field: 'project', enabled: true }],
			}),
		).rows;
		expect(rows.map((row) => [row.type, row.depth])).toEqual([
			['project-header', 0],
			['chat', 1],
			['project-header', 2],
			['chat', 3],
			['chat', 4],
			['project-header', 2],
			['chat', 3],
		]);
		expect(guides(rows).map((guide) => guide.slice(2))).toEqual([
			[undefined, undefined, []],
			[undefined, undefined, []],
			[1, false, []],
			[2, true, [1]],
			[3, true, [1]],
			[1, true, []],
			[2, true, []],
		]);
	});

	it('terminates at a trailing collapsed header and recomputes after search bypasses collapse', () => {
		const chats = [
			chat('root'),
			delegated('a', 'root', { projectPath: '/a' }),
			delegated('b', 'root', { projectPath: '/b' }),
		];
		const input = projectionInput(chats, { groupingFields: [{ field: 'project', enabled: true }] });
		const expanded = buildSidebarRowModel(input);
		const tailHeader = expanded.rows.at(-2)!;
		const collapsed = buildSidebarRowModel({
			...input,
			collapsedProjectKeys: new Set([tailHeader.key]),
		});
		expect(collapsed.rows.at(-1)).toMatchObject({
			key: tailHeader.key,
			tree: { isLastChild: true },
		});
		expect(collapsed.visibleChatIds).toEqual(['root', 'a']);
		const filtered = buildSidebarRowModel({
			...input,
			collapsedProjectKeys: new Set([tailHeader.key]),
			matchingChatIds: new Set(['b']),
		});
		expect(filtered.visibleChatIds).toEqual(['root', 'b']);
		expect(filtered.rows.filter((row) => row.tree).every((row) => row.tree!.isLastChild)).toBe(
			true,
		);
	});

	it('updates terminal siblings after filtering, collapse, and optimistic order changes', () => {
		const chats = [
			chat('root'),
			delegated('a', 'root'),
			delegated('a1', 'a'),
			delegated('b', 'root'),
		];
		const input = projectionInput(chats);
		const filtered = buildSidebarRowModel({ ...input, matchingChatIds: new Set(['a1']) });
		expect(filtered.rows.find((row) => row.key === 'chat:a')).toMatchObject({
			contextOnly: true,
			tree: { isLastChild: true },
		});
		expect(filtered.rows.at(-1)?.tree?.continuations).toBeNull();
		const collapsed = buildSidebarRowModel({
			...input,
			collapsedProjectKeys: new Set(['delegation:a']),
		});
		expect(collapsed.visibleChatIds).toEqual(['root', 'a', 'b']);
		expect(collapsed.rows[1].tree?.isLastChild).toBe(false);
		const reordered = buildSidebarRowModel({
			...input,
			orders: { ...input.orders, normal: ['root', 'b', 'a', 'a1'] },
		});
		expect(reordered.visibleChatIds).toEqual(['root', 'b', 'a', 'a1']);
		expect(reordered.rows[1].tree?.isLastChild).toBe(false);
		expect(reordered.rows[2].tree?.isLastChild).toBe(true);
		expect(reordered.rows[3].tree?.continuations).toBeNull();
	});

	it('uses displayed band order and normalized cycle ancestry', () => {
		const chats = [
			chat('root'),
			delegated('archived', 'root', { isArchived: true }),
			delegated('normal', 'root'),
			delegated('pinned', 'root', { isPinned: true }),
			delegated('cycle-a', 'cycle-b'),
			delegated('cycle-b', 'cycle-a'),
		];
		const rows = buildSidebarRowModel(projectionInput(chats)).rows;
		expect(rows.filter((row) => row.tree).map((row) => [row.key, row.tree!.isLastChild])).toEqual([
			['chat:pinned', false],
			['chat:normal', false],
			['chat:archived', true],
			['chat:cycle-b', true],
		]);
		expect(rows.find((row) => row.key === 'chat:cycle-a')?.tree).toBeUndefined();
	});

	it('shares continuation tails rather than copying ancestry in a deep branching tree', () => {
		const chats = [chat('root')];
		for (let depth = 1; depth <= 2000; depth++) {
			const parent = depth === 1 ? 'root' : `branch-${depth - 1}`;
			chats.push(delegated(`branch-${depth}`, parent), delegated(`tail-${depth}`, parent));
		}
		const rows = buildSidebarRowModel(projectionInput(chats)).rows;
		const links = new Set<SidebarTreeContinuation>();
		for (const row of rows) {
			for (let rail = row.tree?.continuations; rail && !links.has(rail); rail = rail.outer)
				links.add(rail);
		}
		expect(links.size).toBe(1999);
		const branch = rows.find((row) => row.key === 'chat:branch-2000')!;
		const tail = rows.find((row) => row.key === 'chat:tail-2000')!;
		expect(branch.tree!.continuations).toBe(tail.tree!.continuations);
		expect(rows).toHaveLength(chats.length);
	});
});
