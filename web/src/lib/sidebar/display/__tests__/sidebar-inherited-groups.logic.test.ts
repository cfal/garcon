import { describe, expect, it } from 'vitest';
import {
	buildSidebarRowModel,
	sidebarGroupCollapseKey,
	sidebarProjectKey,
} from '../sidebar-row-model';
import { SIDEBAR_GROUPING_FIELDS } from '../sidebar-preferences';
import { sidebarChatInset, sidebarHeaderInset } from '../sidebar-virtual-chat-list';
import { chat, delegated, projectionInput } from './sidebar-fixtures';

const groupingFields = SIDEBAR_GROUPING_FIELDS.map((field) => ({ field, enabled: true }));

describe('inherited delegated grouping', () => {
	it('omits identical fields recursively without changing scope identities or bands', () => {
		const model = buildSidebarRowModel(
			projectionInput(
				[chat('parent'), delegated('child', 'parent'), delegated('grandchild', 'child')],
				{ groupingFields },
			),
		);
		expect(model.rows.filter((row) => row.type !== 'chat')).toHaveLength(4);
		expect(model.rows.filter((row) => row.type === 'chat').map((row) => row.depth)).toEqual([
			4, 5, 6,
		]);
		expect(model.rows.find((row) => row.key === 'chat:child')).toMatchObject({
			executorGrouped: true,
			section: 'inactive',
			reorderScopeKey: JSON.stringify([
				true,
				false,
				'parent',
				'normal',
				[
					['executor', 'local'],
					['project', sidebarProjectKey('/workspace/app', 'local')],
					['activity', 'inactive'],
					['status', 'caught-up'],
				],
			]),
			reorderScopeIds: ['child'],
		});
	});

	it.each([false, true])(
		'keeps a differing field for all siblings, even when hidden (search=%s)',
		(search) => {
			const model = buildSidebarRowModel(
				projectionInput(
					[
						chat('parent'),
						delegated('same', 'parent'),
						delegated('different', 'parent', { isUnread: true }),
					],
					{ groupingFields, matchingChatIds: search ? new Set(['same']) : undefined },
				),
			);
			const parentIndex = model.rows.findIndex((row) => row.key === 'chat:parent');
			const headers = model.rows.slice(parentIndex + 1).filter((row) => row.type !== 'chat');
			expect(
				headers.map((row) => (row.type === 'section-header' ? row.section : row.type)),
			).toEqual(search ? ['caught-up'] : ['ready-for-review', 'caught-up']);
			expect(model.rows.find((row) => row.key === 'chat:same')?.depth).toBe(6);
		},
	);

	it('does not omit a unanimous child value that differs from its parent', () => {
		const model = buildSidebarRowModel(
			projectionInput(
				[
					chat('parent'),
					delegated('a', 'parent', { isUnread: true }),
					delegated('b', 'parent', { isUnread: true }),
				],
				{ groupingFields },
			),
		);
		expect(
			model.rows.filter((row) => row.type === 'section-header').map((row) => row.section),
		).toEqual(['inactive', 'caught-up', 'ready-for-review']);
		expect(model.rows.find((row) => row.key === 'chat:a')).toMatchObject({
			depth: 6,
			reorderScopeIds: ['a', 'b'],
		});
	});

	it.each([
		['/repo/', false, 'local', 1],
		['/repo/app', true, 'local', 1],
		['/repo/app', false, 'local', 2],
		['/repo/', true, 'remote', 2],
	] as const)(
		'compares effective project identities: %s, combine=%s, executor=%s',
		(path, combine, executor, count) => {
			const model = buildSidebarRowModel(
				projectionInput(
					[
						chat('parent', { projectPath: '/repo' }),
						delegated('child', 'parent', { projectPath: path, executorId: executor }),
					],
					{
						groupingFields: [{ field: 'project', enabled: true }],
						groupNestedProjectPaths: combine,
					},
				),
			);
			expect(model.rows.filter((row) => row.type === 'project-header')).toHaveLength(count);
		},
	);

	it('ignores collapse on an omitted header but preserves collapse on a visible later field', () => {
		const path = [['executor', 'local']] as const;
		const input = projectionInput(
			[chat('parent'), delegated('child', 'parent', { projectPath: '/other' })],
			{
				groupingFields: [
					{ field: 'executor', enabled: true },
					{ field: 'project', enabled: true },
				],
				collapsedProjectKeys: new Set([sidebarGroupCollapseKey('parent', path)]),
			},
		);
		const expanded = buildSidebarRowModel(input);
		expect(expanded.visibleChatIds).toEqual(['parent', 'child']);
		const key = sidebarGroupCollapseKey('parent', [
			...path,
			['project', sidebarProjectKey('/other', 'local')],
		]);
		expect(expanded.rows.find((row) => row.key === key)).toMatchObject({
			depth: 3,
			executorGrouped: true,
		});
		expect(
			buildSidebarRowModel({ ...input, collapsedProjectKeys: new Set([key]) }).visibleChatIds,
		).toEqual(['parent']);
	});

	it('preserves every visible group inset beyond depth six', () => {
		const model = buildSidebarRowModel(
			projectionInput(
				[
					chat('parent'),
					delegated('child', 'parent', {
						executorId: 'remote',
						projectPath: '/other',
						isUnread: true,
						lastActivityAt: '2026-02-01T11:00:00Z',
					}),
				],
				{ groupingFields },
			),
		);
		const rows = model.rows.filter((row) => row.type === 'chat');
		expect(rows.map((row) => row.depth)).toEqual([4, 9]);
		expect(rows.map((row) => sidebarChatInset(row.depth))).toEqual([60, 120]);
		for (let depth = 6; depth <= 10; depth++) {
			expect(sidebarHeaderInset(depth)).toBe(6 + depth * 12);
			expect(sidebarChatInset(depth + 1)).toBe(sidebarHeaderInset(depth) + 18);
		}
	});
});
