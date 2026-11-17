import { describe, expect, it } from 'vitest';
import { buildSidebarDelegationForest } from '../sidebar-delegation';
import { buildSidebarRowModel } from '../sidebar-row-model';
import type { SidebarGroupingField } from '../sidebar-preferences';
import type {
	SidebarVirtualChatRow,
	SidebarVirtualSectionHeaderRow,
} from '../sidebar-virtual-chat-list';
import { chat, delegated, projectionInput } from './sidebar-fixtures';

function family() {
	return [
		chat('parent'),
		delegated('live', 'parent'),
		delegated('archive', 'live', { isArchived: true, orderGroup: 'archived' }),
		delegated('inside', 'archive', { isUnread: true, lastActivityAt: '2026-02-01T11:00:00Z' }),
		delegated('deep-archive', 'inside', { isArchived: true, orderGroup: 'archived' }),
		delegated('deep-live', 'deep-archive'),
		chat('other', { lastActivityAt: '2026-01-20T00:00:00Z' }),
		chat('archive-peer', { isArchived: true, orderGroup: 'archived' }),
	];
}

const options = { nestDelegatedChats: true, separateArchivedBranches: true };

describe('separate archived branches', () => {
	it('promotes an archived branch intact without changing lineage or order', () => {
		const chats = family();
		const before = structuredClone(chats);
		const input = projectionInput(chats, options);
		const orders = structuredClone(input.orders);
		const model = buildSidebarRowModel(input);
		const rows = model.rows.filter((row): row is SidebarVirtualChatRow => row.type === 'chat');
		expect(rows.map((row) => [row.chat.id, row.depth])).toEqual([
			['parent', 0],
			['live', 1],
			['other', 0],
			['archive', 0],
			['inside', 1],
			['deep-archive', 2],
			['deep-live', 3],
			['archive-peer', 0],
		]);
		expect(rows.find((row) => row.chat.id === 'archive')).toMatchObject({
			reorderScopeIds: ['archive', 'archive-peer'],
			branch: { descendants: 3, unread: 1 },
		});
		expect(rows.find((row) => row.chat.id === 'deep-archive')?.reorderScopeIds).toEqual([
			'deep-archive',
		]);
		expect(chats).toEqual(before);
		expect(input.orders).toEqual(orders);
	});

	it('preserves mixed descendants beneath an already archived root', () => {
		const chats = family();
		chats[0] = { ...chats[0], isArchived: true, orderGroup: 'archived' };
		const forest = buildSidebarDelegationForest(chats, options);
		expect(forest.roots).toEqual(['parent', 'other', 'archive-peer']);
		expect(forest.branches.get('parent')?.descendants).toBe(5);
		expect(forest.branches.get('archive')?.parentId).toBe('live');
		expect(forest.branches.get('deep-archive')?.parentId).toBe('inside');
	});

	it.each([false, true])(
		'retains the old projection when separation is off (nesting=%s)',
		(nestDelegatedChats) => {
			const input = projectionInput(family(), { nestDelegatedChats });
			const summarize = (separateArchivedBranches?: boolean) =>
				buildSidebarRowModel({ ...input, separateArchivedBranches }).rows.map((row) => ({
					key: row.key,
					depth: row.depth,
					scope: row.type === 'chat' ? row.reorderScopeKey : null,
				}));
			expect(summarize(false)).toEqual(summarize());
			if (!nestDelegatedChats) expect(summarize(true)).toEqual(summarize(false));
		},
	);

	it('recomputes interval containment, aggregates and recency for the displayed forest', () => {
		const chats = family();
		const forest = buildSidebarDelegationForest(chats, options);
		expect(forest.branches.get('parent')).toMatchObject({ descendants: 1, unread: 0 });
		expect(forest.contains('parent', 'live')).toBe(true);
		expect(forest.contains('parent', 'archive')).toBe(false);
		expect(forest.contains('parent', 'other')).toBe(false);
		expect(forest.contains('archive', 'deep-live')).toBe(true);
		expect(forest.contains('archive', 'archive-peer')).toBe(false);
		const model = buildSidebarRowModel(projectionInput(chats, { ...options, sortMode: 'recent' }));
		expect(model.visibleChatIds.slice(0, 3)).toEqual(['other', 'parent', 'live']);
		expect(model.visibleChatIds.slice(3)).toEqual([
			'archive',
			'inside',
			'deep-archive',
			'deep-live',
			'archive-peer',
		]);
	});

	it('uses only surviving ancestors as search context and bypasses their saved collapse', () => {
		const model = buildSidebarRowModel(
			projectionInput(family(), {
				...options,
				matchingChatIds: new Set(['deep-live']),
				collapsedProjectKeys: new Set(['delegation:parent', 'delegation:archive']),
			}),
		);
		expect(model.visibleChatIds).toEqual(['archive', 'inside', 'deep-archive', 'deep-live']);
		expect(model.actionableChatIds).toEqual(['deep-live']);
		expect(model.matchingChatIds).toEqual(['deep-live']);
	});

	it('does not hide a separated branch with its former parent but preserves its own collapse', () => {
		const model = buildSidebarRowModel(
			projectionInput(family(), {
				...options,
				collapsedProjectKeys: new Set(['delegation:parent', 'delegation:archive']),
			}),
		);
		expect(model.visibleChatIds).toEqual(['parent', 'other', 'archive', 'archive-peer']);
		const archive = model.rows.find((row) => row.type === 'chat' && row.chat.id === 'archive');
		expect(archive?.type === 'chat' && archive.branch?.containsChat('deep-live')).toBe(true);
	});

	it.each<{ fields: SidebarGroupingField[] }>([
		{ fields: [] },
		{ fields: ['activity'] },
		{ fields: ['project', 'activity'] },
		{ fields: ['activity', 'project'] },
	])(
		'preserves grouping precedence without manufacturing archive headers ($fields)',
		({ fields }) => {
			const model = buildSidebarRowModel(
				projectionInput(family(), {
					...options,
					groupingFields: fields.map((field) => ({ field, enabled: true })),
				}),
			);
			const headers = model.rows.filter(
				(row): row is SidebarVirtualSectionHeaderRow =>
					row.type === 'section-header' && row.section === 'archived',
			);
			expect(headers.length > 0).toBe(fields.includes('activity'));
			const rootHeader = headers.find((row) => row.containsChat('archive'));
			expect(rootHeader !== undefined).toBe(fields.includes('activity'));
			if (rootHeader) {
				expect(rootHeader.containsChat('deep-live')).toBe(true);
				expect(rootHeader.containsChat('parent')).toBe(false);
				expect(rootHeader.depth).toBe(fields.indexOf('activity'));
			}
			expect(new Set(model.visibleChatIds).size).toBe(family().length);
		},
	);

	it('handles missing parents and cycles without inventing ancestry', () => {
		const forest = buildSidebarDelegationForest(
			[
				delegated('orphan', 'missing', { isArchived: true }),
				delegated('child', 'orphan'),
				delegated('a', 'b'),
				delegated('b', 'a', { isArchived: true }),
			],
			options,
		);
		expect(forest.roots).toEqual(['orphan', 'a', 'b']);
		expect(forest.contains('orphan', 'child')).toBe(true);
		expect(forest.ambiguousIds).toEqual(new Set(['a', 'b']));
		expect(forest.preorder).toHaveLength(4);
	});

	it('keeps long mixed chains iterative and separates only the first archived ancestor', () => {
		const chats = Array.from({ length: 12_000 }, (_, index) =>
			delegated(String(index), String(index - 1), {
				isArchived: index === 6000 || index === 9000,
			}),
		);
		const forest = buildSidebarDelegationForest(chats, options);
		expect(forest.roots).toEqual(['0', '6000']);
		expect(forest.branches.get('0')?.descendants).toBe(5999);
		expect(forest.branches.get('6000')?.descendants).toBe(5999);
		expect(forest.branches.get('9000')?.parentId).toBe('8999');
	});
});
