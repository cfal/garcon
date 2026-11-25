import { describe, expect, it } from 'vitest';
import {
	buildSidebarRowModel,
	buildSidebarChatOrderMap,
	sidebarActivitySection,
	sidebarStatusSection,
} from '../sidebar-row-model';
import { buildSidebarDelegationForest } from '../sidebar-delegation';
import {
	normalizeSidebarGroupingFields,
	SIDEBAR_GROUPING_FIELDS,
	type SidebarGroupingField,
} from '../sidebar-preferences';
import { chat, delegated, projectionInput } from './sidebar-fixtures';

function selections(fields: readonly SidebarGroupingField[]) {
	return normalizeSidebarGroupingFields(fields.map((field) => ({ field, enabled: true })));
}

function permutations(fields: readonly SidebarGroupingField[]): SidebarGroupingField[][] {
	return [
		[],
		...fields.flatMap((field) =>
			permutations(fields.filter((other) => other !== field)).map((rest) => [field, ...rest]),
		),
	];
}

describe('sidebar display preferences', () => {
	it('normalizes unknown and duplicate fields without losing disabled positions', () => {
		expect(
			normalizeSidebarGroupingFields([
				{ field: 'status', enabled: false },
				{ field: 'project', enabled: true },
				{ field: 'status', enabled: true },
				{ field: 'invalid', enabled: true },
			]),
		).toEqual([
			{ field: 'status', enabled: false },
			{ field: 'project', enabled: true },
			{ field: 'executor', enabled: false },
			{ field: 'activity', enabled: false },
		]);
	});
});

describe('recursive sidebar projection', () => {
	it('does not index project paths when project grouping is disabled', () => {
		let reads = 0;
		const record = {
			...chat('a'),
			get projectPath() {
				reads++;
				return '/workspace/project';
			},
		};
		const model = buildSidebarRowModel(projectionInput([record], {
			groupingFields: selections(['status']),
			groupNestedProjectPaths: true,
		}));
		expect(model.visibleChatIds).toEqual(['a']);
		expect(reads).toBe(0);
	});

	it.each(permutations(SIDEBAR_GROUPING_FIELDS))(
		'indents every grouping level in order %j',
		(...fields) => {
			const chats = [chat('parent'), delegated('child', 'parent')];
			const depth = fields.length;
			for (const nestDelegatedChats of [false, true]) {
				const model = buildSidebarRowModel(
					projectionInput(chats, {
						groupingFields: selections(fields),
						nestDelegatedChats,
					}),
				);
				expect(model.rows.filter((row) => row.type === 'chat').map((row) => row.depth)).toEqual(
					nestDelegatedChats ? [depth, depth + 1] : [depth, depth],
				);
			}
		},
	);

	it.each([false, true])('keeps equivalent project identities stable (combine: %s)', (combine) => {
		const chats = [chat('a', { projectPath: '/repo/' }), chat('b', { projectPath: '/repo' })];
		const input = projectionInput(chats, {
			groupingFields: selections(['project']),
			groupNestedProjectPaths: combine,
		});
		const first = buildSidebarRowModel(input);
		const reversed = buildSidebarRowModel({ ...input, allChats: [...chats].reverse() });
		expect(reversed.rows).toMatchObject(first.rows.map(({ key }) => ({ key })));
		expect(first.rows[0]).toMatchObject({ projectPath: '/repo', showParentPath: false });
		const collapsed = buildSidebarRowModel({
			...input,
			allChats: [chats[1]],
			groupNestedProjectPaths: !combine,
			collapsedProjectKeys: new Set([first.rows[0].key]),
		});
		expect(collapsed.visibleChatIds).toEqual([]);
	});
	it('preserves project grouping when removing a trailing slash exposes whitespace', () => {
		const input = projectionInput(
			[chat('a', { projectPath: '/repo' }), chat('b', { projectPath: '/repo /' })],
			{ groupingFields: selections(['project']), groupNestedProjectPaths: false },
		);
		const model = buildSidebarRowModel(input);
		expect(model.rows).toMatchObject([
			{ type: 'project-header', projectPath: '/repo', count: 2 },
			{ type: 'chat', chat: { id: 'a' }, reorderScopeIds: ['a', 'b'] },
			{ type: 'chat', chat: { id: 'b' }, reorderScopeIds: ['a', 'b'] },
		]);
		expect(
			buildSidebarRowModel({ ...input, collapsedProjectKeys: new Set([model.rows[0].key]) })
				.visibleChatIds,
		).toEqual([]);
	});
	it.each([['project'], ['executor', 'project']] as const)(
		'disambiguates folder names only within an executor: %j',
		(...fields) => {
			const model = buildSidebarRowModel(projectionInput([
				chat('a', { projectPath: '/clients/app' }),
				chat('b', { projectPath: '/forks/app' }),
				chat('c', { projectPath: '/remote/app', executorId: 'remote' }),
			], { groupingFields: selections(fields) }));
			expect(model.rows.filter((row) => row.type === 'project-header').map((row) =>
				[row.projectPath, row.showParentPath],
			)).toEqual([['/clients/app', true], ['/forks/app', true], ['/remote/app', false]]);
		},
	);
	it.each([false, true])(
		'preserves timestamp fallbacks and canonical ties (nested: %s)',
		(nestDelegatedChats) => {
			const clockId = String(BigInt(Date.UTC(2026, 8, 3)) * 1000n);
			const chats = [
				chat('invalid', { createdAt: 'invalid', lastActivityAt: null }),
				chat('0000000000000000', { createdAt: null, lastActivityAt: 'invalid' }),
				chat('activity', { lastActivityAt: '2026-09-10T00:00:00Z' }),
				chat(clockId, {
					createdAt: '2026-01-01T00:00:00Z',
					lastActivityAt: '2026-01-01T00:00:00Z',
				}),
				chat('created', {
					createdAt: '2026-08-01T00:00:00Z',
					lastActivityAt: '2026-01-01T00:00:00Z',
				}),
				chat('tie', { createdAt: '2026-08-01T00:00:00Z', lastActivityAt: null }),
			];
			const before = structuredClone(chats);
			const input = projectionInput(chats, { nestDelegatedChats, sortMode: 'recent' });
			expect(buildSidebarRowModel(input).visibleChatIds).toEqual([
				'activity',
				clockId,
				'created',
				'tie',
				'invalid',
				'0000000000000000',
			]);
			expect(chats).toEqual(before);
			expect(buildSidebarRowModel({ ...input, sortMode: 'manual' }).visibleChatIds).toEqual(
				chats.map((chat) => chat.id),
			);
		},
	);
	it.each(['top', 'bottom'] as const)(
		'preserves draft direction and independent bands with %s pins',
		(pinnedInsertPosition) => {
			const chats = [
				chat('pin-draft', {
					isPinned: true,
					status: 'draft',
					createdAt: null,
					lastActivityAt: null,
				}),
				chat('pin-new', { isPinned: true, lastActivityAt: '2026-02-01T00:00:00Z' }),
				chat('pin-old', { isPinned: true }),
				chat('pin-tie', { isPinned: true }),
				chat('normal-old'),
				chat('normal-new', { lastActivityAt: '2026-02-01T00:00:00Z' }),
				chat('normal-draft', { status: 'draft', createdAt: null, lastActivityAt: null }),
				chat('archive-old', { isArchived: true }),
				chat('archive-new', { isArchived: true, lastActivityAt: '2026-02-01T00:00:00Z' }),
			];
			expect(
				buildSidebarRowModel(projectionInput(chats, { sortMode: 'recent', pinnedInsertPosition }))
					.visibleChatIds,
			).toEqual([
				...(pinnedInsertPosition === 'top'
					? ['pin-draft', 'pin-new', 'pin-old', 'pin-tie']
					: ['pin-old', 'pin-tie', 'pin-new', 'pin-draft']),
				'normal-draft',
				'normal-new',
				'normal-old',
				'archive-new',
				'archive-old',
			]);
		},
	);
	it('retains optimistic archive operation order ahead of recent archived chats', () => {
		const chats = [
			chat('normal'),
			chat('pending-second', { isArchived: true }),
			chat('pending-first', { isArchived: true }),
			chat('new', { isArchived: true, lastActivityAt: '2026-02-01T00:00:00Z' }),
			chat('old', { isArchived: true }),
		];
		const input = projectionInput(chats, {
			sortMode: 'recent',
			isChatOptimisticallyArchived: (id) => id.startsWith('pending-'),
		});
		expect(buildSidebarRowModel(input).visibleChatIds).toEqual([
			'normal',
			'pending-second',
			'pending-first',
			'new',
			'old',
		]);
		expect(
			buildSidebarRowModel({ ...input, isChatOptimisticallyArchived: () => false }).visibleChatIds,
		).toEqual(['normal', 'new', 'pending-second', 'pending-first', 'old']);
	});
	it('reads recency once per chat rather than in the comparator', () => {
		let reads = 0;
		const chats = Array.from({ length: 200 }, (_, index) => {
			const item = chat(String(index), { isPinned: index % 2 === 0 });
			Object.defineProperty(item, 'lastActivityAt', {
				get() {
					reads++;
					return new Date(1_700_000_000_000 + index * 1000).toISOString();
				},
			});
			return item;
		});
		expect(
			buildSidebarRowModel(
				projectionInput(chats, { sortMode: 'recent', pinnedInsertPosition: 'bottom' }),
			).visibleChatIds,
		).toHaveLength(200);
		expect(reads).toBe(200);
	});
	it.each(permutations(SIDEBAR_GROUPING_FIELDS).map((fields) => [fields]))(
		'applies grouping precedence %j at every sibling level',
		(fields) => {
			const chats = [
				chat('parent'),
				delegated('child', 'parent', {
					executorId: 'remote',
					projectPath: '/remote',
					isUnread: true,
					lastActivityAt: '2026-02-01T11:00:00Z',
				}),
				chat('other', { projectPath: '/workspace/notes' }),
			];
			const model = buildSidebarRowModel(
				projectionInput(chats, { groupingFields: selections(fields) }),
			);
			expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
			expect(model.visibleChatIds).toEqual(['parent', 'child', 'other']);
			const parent = model.rows.findIndex((row) => row.type === 'chat' && row.chat.id === 'parent');
			const childHeaders = model.rows.slice(parent + 1, parent + 1 + fields.length);
			const headerTypes = {
				executor: 'executor-header',
				project: 'project-header',
				activity: 'section-header',
				status: 'section-header',
			};
			expect(childHeaders.map((row) => row.type)).toEqual(
				fields.map((field) => headerTypes[field]),
			);
		},
	);
	it('moves a root without relocating interleaved descendants', () => {
		const chats = [delegated('b1', 'B'), chat('A'), chat('B'), delegated('a1', 'A')];
		const input = projectionInput(chats);
		expect(buildSidebarRowModel(input).visibleChatIds).toEqual(['A', 'a1', 'B', 'b1']);
		input.orders.normal = ['b1', 'B', 'A', 'a1'];
		expect(buildSidebarRowModel(input).visibleChatIds).toEqual(['B', 'b1', 'A', 'a1']);
		expect(buildSidebarRowModel({ ...input, nestDelegatedChats: false }).visibleChatIds).toEqual(
			input.orders.normal,
		);
	});
	it('keeps cross-band descendants under their actual parents and excludes fork/handoff links', () => {
		const chats = [
			chat('root', { isArchived: true }),
			delegated('pinned', 'root', { isPinned: true }),
			delegated('normal', 'root'),
			chat('fork', {
				parentChatId: null,
				lineage: {
					sourceChatId: 'root',
					kind: 'fork',
					transcriptViewId: 'view-fixture',
					ordinal: 0,
				},
			}),
			chat('handoff', {
				parentChatId: null,
				lineage: {
					sourceChatId: 'root',
					kind: 'handoff',
					transcriptViewId: 'view-fixture',
					ordinal: 0,
				},
			}),
		];
		const model = buildSidebarRowModel(projectionInput(chats));
		expect(model.visibleChatIds).toEqual(['fork', 'handoff', 'root', 'pinned', 'normal']);
		expect(model.rows.find((row) => row.key === 'chat:pinned')).toMatchObject({
			reorderScopeIds: ['pinned'],
		});
	});
	it('includes minimum ancestor context and keeps action matches separate', () => {
		const chats = [
			chat('root'),
			delegated('child', 'root'),
			delegated('match', 'child'),
			delegated('hidden', 'root'),
		];
		const model = buildSidebarRowModel(
			projectionInput(chats, {
				matchingChatIds: new Set(['match']),
				collapsedProjectKeys: new Set(['delegation:root', 'delegation:child']),
			}),
		);
		expect(model.visibleChatIds).toEqual(['root', 'child', 'match']);
		expect(model.matchingChatIds).toEqual(['match']);
		expect(model.actionableChatIds).toEqual(['match']);
		expect(model.rows.find((row) => row.key === 'chat:root')).toMatchObject({
			reorderScopeIds: [],
		});
		expect(
			buildSidebarRowModel(projectionInput(chats, { matchingChatIds: new Set(['root']) }))
				.visibleChatIds,
		).toEqual(['root']);
	});
	it('aggregates hidden and archived descendant activity without changing own-chat groups', () => {
		const chats = [
			chat('other', { lastActivityAt: '2026-01-20T00:00:00Z' }),
			chat('root'),
			delegated('child', 'root'),
			delegated('latest', 'child', {
				isArchived: true,
				isUnread: true,
				isProcessing: true,
				lastActivityAt: '2026-02-01T11:00:00Z',
			}),
		];
		const model = buildSidebarRowModel(
			projectionInput(chats, {
				sortMode: 'recent',
				groupingFields: selections(['activity', 'status']),
				collapsedProjectKeys: new Set(['delegation:root']),
			}),
		);
		expect(model.visibleChatIds).toEqual(['root', 'other']);
		const root = model.rows.find((row) => row.type === 'chat' && row.chat.id === 'root');
		expect(root).toMatchObject({
			section: 'inactive',
			branch: { descendants: 2, unread: 1, processing: 1, isCollapsed: true },
		});
		expect(
			model.rows.some((row) => row.type === 'section-header' && row.section === 'in-progress'),
		).toBe(false);
	});

	it('applies the collapse default to each untouched parent, but not to search or flat lists', () => {
		const chats = [chat('root'), delegated('child', 'root'), delegated('leaf', 'child')];
		const input = projectionInput(chats, {
			collapseDelegatedChatsByDefault: true,
			groupingFields: selections(['project']),
		});
		expect(buildSidebarRowModel(input).visibleChatIds).toEqual(['root']);
		const expandedRoot = buildSidebarRowModel({
			...input,
			expandedDelegationKeys: new Set(['delegation:root']),
		});
		expect(expandedRoot.visibleChatIds).toEqual(['root', 'child']);
		const search = buildSidebarRowModel({ ...input, matchingChatIds: new Set(['leaf']) });
		expect(search.visibleChatIds).toEqual(['root', 'child', 'leaf']);
		expect(search.actionableChatIds).toEqual(['leaf']);
		const flat = buildSidebarRowModel({ ...input, nestDelegatedChats: false });
		expect(flat.visibleChatIds).toEqual(['root', 'child', 'leaf']);
	});
	it.each(['top', 'bottom'] as const)(
		'honors pinned %s branch recency at each level and stable ties',
		(pinnedInsertPosition) => {
			const chats = [
				chat('older', { isPinned: true }),
				chat('newer', { isPinned: true }),
				delegated('latest', 'newer', { lastActivityAt: '2026-02-01T11:00:00Z' }),
				delegated('a', 'older', { isPinned: true }),
				delegated('b', 'older', { isPinned: true }),
			];
			const model = buildSidebarRowModel(
				projectionInput(chats, { sortMode: 'recent', pinnedInsertPosition }),
			);
			expect(model.visibleChatIds).toEqual(
				pinnedInsertPosition === 'top'
					? ['newer', 'latest', 'older', 'a', 'b']
					: ['older', 'a', 'b', 'newer', 'latest'],
			);
		},
	);
	it('promotes a missing-parent branch without attaching it to a grandparent', () => {
		const chats = [delegated('child', 'missing'), delegated('grandchild', 'child'), chat('other')];
		expect(buildSidebarRowModel(projectionInput(chats)).visibleChatIds).toEqual([
			'child',
			'grandchild',
			'other',
		]);
	});
	it('cuts malformed cycles deterministically without mutating lineage', () => {
		const chats = [delegated('b', 'a'), delegated('a', 'b'), delegated('self', 'self')];
		const forest = buildSidebarDelegationForest(chats, { nestDelegatedChats: true });
		expect(forest.roots).toEqual(['a', 'self']);
		expect(forest.ambiguousIds).toEqual(new Set(['a', 'b', 'self']));
		expect(chats[1].parentChatId).toBe('b');
		expect(buildSidebarRowModel(projectionInput(chats)).visibleChatIds).toEqual(['a', 'b', 'self']);
	});
	it('combines only known executor-qualified ancestors from the full roster', () => {
		const chats = [
			chat('parent', { projectPath: '/repo' }),
			chat('nested', { projectPath: '/repo/app' }),
			chat('remote', { projectPath: '/repo/app', executorId: 'remote' }),
			chat('prefix', { projectPath: '/repo-copy' }),
		];
		const model = buildSidebarRowModel(
			projectionInput(chats, {
				groupingFields: selections(['project']),
				matchingChatIds: new Set(['nested', 'remote', 'prefix']),
				groupNestedProjectPaths: true,
			}),
		);
		expect(
			model.rows
				.filter((row) => row.type === 'project-header')
				.map((row) => [row.executorId, row.projectPath]),
		).toEqual([
			['local', '/repo'],
			['local', '/repo-copy'],
			['remote', '/repo/app'],
		]);
	});
	it('keeps grouped collapse identity scoped to structural parent and complete path', () => {
		const chats = [
			chat('a'), delegated('a1', 'a', { projectPath: '/other' }),
			chat('b'), delegated('b1', 'b', { projectPath: '/other' }),
		];
		const input = projectionInput(chats, { groupingFields: selections(['project']) });
		const expanded = buildSidebarRowModel(input);
		const childHeader = expanded.rows[2];
		const collapsed = buildSidebarRowModel({
			...input,
			collapsedProjectKeys: new Set([childHeader.key]),
		});
		expect(collapsed.visibleChatIds).toEqual(['a', 'b', 'b1']);
		expect(collapsed.rows.find((row) => row.key === childHeader.key)).toMatchObject({
			isCollapsed: true,
			count: 1,
		});
	});
	it('handles a deep chain with linear structural memory and no recursion', () => {
		const chats = Array.from({ length: 12000 }, (_, index) =>
			index ? delegated(String(index), String(index - 1)) : chat('0'),
		);
		const model = buildSidebarRowModel(projectionInput(chats));
		expect(model.rows).toHaveLength(chats.length);
		expect(model.rows[0]).toMatchObject({ branch: { descendants: chats.length - 1 } });
		expect(model.visibleChatIds).toEqual(chats.map((chat) => chat.id));
	});
	it('retains own-chat activity and status priority, timestamp fallback, and drafts', () => {
		const now = new Date('2026-02-01T00:00:00Z');
		expect(sidebarActivitySection(chat('old'), now, '3-days')).toBe('inactive');
		expect(
			sidebarActivitySection(
				chat('draft', { status: 'draft', createdAt: null, lastActivityAt: null }),
				now,
				'3-days',
			),
		).toBe('active');
		expect(sidebarActivitySection(chat('archived', { isArchived: true }), now, '3-days')).toBe(
			'archived',
		);
		expect(sidebarActivitySection(chat('pinned', { isPinned: true }), now, '3-days')).toBe(
			'active',
		);
		expect(
			sidebarActivitySection(
				chat('recent', { createdAt: now.toISOString(), lastActivityAt: null }),
				now,
				'3-days',
			),
		).toBe('active');
		expect(sidebarStatusSection({ isProcessing: true, isUnread: true })).toBe('in-progress');
		expect(sidebarStatusSection({ isProcessing: false, isUnread: true })).toBe('ready-for-review');
		expect(sidebarStatusSection({ isProcessing: false, isUnread: false })).toBe('caught-up');
		expect(
			buildSidebarChatOrderMap([
				chat('p', { isPinned: true }),
				chat('a', { isArchived: true }),
				chat('n'),
			]),
		).toEqual({ pinned: ['p'], normal: ['n'], archived: ['a'] });
	});
});
