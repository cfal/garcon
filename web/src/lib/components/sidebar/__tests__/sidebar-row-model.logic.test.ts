import { describe, expect, it } from 'vitest';
import {
	buildSidebarChatOrderMap,
	buildSidebarDisplayChatIds as buildSidebarDisplayChatIdsBase,
	buildSidebarProjectKeys,
	buildSidebarRowModel as buildSidebarRowModelBase,
	sidebarActivitySection,
	sidebarProjectKey,
} from '../sidebar-row-model';
import { SIDEBAR_INACTIVITY_DURATION_MS } from '../chat-inactivity';
import type { SidebarInactivityDuration } from '$lib/stores/local-settings.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

const TEST_NOW = new Date('2025-06-01T12:00:00.000Z');
const TEST_INACTIVITY_DURATION: SidebarInactivityDuration = '3-days';

function buildSidebarRowModel(
	input: Omit<Parameters<typeof buildSidebarRowModelBase>[0], 'inactivityDuration'> & {
		inactivityDuration?: SidebarInactivityDuration;
	},
) {
	return buildSidebarRowModelBase({
		inactivityDuration: TEST_INACTIVITY_DURATION,
		...input,
	});
}

function buildSidebarDisplayChatIds(
	input: Omit<
		Parameters<typeof buildSidebarDisplayChatIdsBase>[0],
		'inactivityDuration' | 'sortMode'
	> & {
		inactivityDuration?: SidebarInactivityDuration;
		sortMode?: 'manual' | 'recent';
	},
) {
	return buildSidebarDisplayChatIdsBase({
		inactivityDuration: TEST_INACTIVITY_DURATION,
		sortMode: 'manual',
		...input,
	});
}

function chat(
	id: string,
	projectPath: string,
	overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord {
	return {
		id,
		projectPath,
		effectiveProjectKey: projectPath,
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'low',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		lastMessage: '',
		tags: [],
		firstMessage: '',
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
	};
}

function rowLabels(model: ReturnType<typeof buildSidebarRowModel>): string[] {
	return model.rows.map((row) => {
		if (row.type === 'project-header') return `header:${row.projectPath}`;
		if (row.type === 'section-header') return `section:${row.section}`;
		return row.chat.id;
	});
}

describe('sidebar row model', () => {
	it('keeps ungrouped rows in pinned, normal, archived order', () => {
		const chats = [
			chat('normal-a', '/p1'),
			chat('pinned-a', '/p1', { isPinned: true }),
			chat('archived-a', '/p1', { isArchived: true }),
			chat('normal-b', '/p2'),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'none',
			currentTime: TEST_NOW,
		});

		expect(rowLabels(model)).toEqual(['pinned-a', 'normal-a', 'normal-b', 'archived-a']);
		expect(model.visibleChatIds).toEqual(['pinned-a', 'normal-a', 'normal-b', 'archived-a']);
		expect(model.visibleOrders).toEqual({
			pinned: ['pinned-a'],
			normal: ['normal-a', 'normal-b'],
			archived: ['archived-a'],
		});
		expect(model.reorderScopesByChatId.get('normal-a')).toEqual(['normal-a', 'normal-b']);
		expect(
			model.rows.find((row) => row.type === 'chat' && row.chat.id === 'normal-a'),
		).toMatchObject({
			type: 'chat',
			reorderScopeKey: 'normal:all',
		});
	});

	it('groups rows alphabetically by project while preserving same-project list order', () => {
		const chats = [
			chat('pinned-p2', '/workspace/p2', { isPinned: true }),
			chat('normal-p1-a', '/workspace/p1'),
			chat('normal-p2-a', '/workspace/p2'),
			chat('normal-p1-b', '/workspace/p1'),
			chat('archived-p1', '/workspace/p1', { isArchived: true }),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project',
			currentTime: TEST_NOW,
		});

		expect(rowLabels(model)).toEqual([
			'header:/workspace/p1',
			'normal-p1-a',
			'normal-p1-b',
			'archived-p1',
			'header:/workspace/p2',
			'pinned-p2',
			'normal-p2-a',
		]);
		expect(model.visibleChatIds).toEqual([
			'normal-p1-a',
			'normal-p1-b',
			'archived-p1',
			'pinned-p2',
			'normal-p2-a',
		]);
		expect(model.visibleOrders).toEqual({
			pinned: ['pinned-p2'],
			normal: ['normal-p1-a', 'normal-p1-b', 'normal-p2-a'],
			archived: ['archived-p1'],
		});
		expect(model.reorderScopesByChatId.get('normal-p1-a')).toEqual(['normal-p1-a', 'normal-p1-b']);
		expect(model.reorderScopesByChatId.get('normal-p2-a')).toEqual(['normal-p2-a']);
	});

	it('omits empty project groups after filtering', () => {
		const allChats = [
			chat('normal-p1-a', '/workspace/p1'),
			chat('normal-p2-a', '/workspace/p2'),
			chat('normal-p1-b', '/workspace/p1'),
		];
		const filteredChats = [allChats[0]!, allChats[2]!];
		const model = buildSidebarRowModel({
			displayedChats: filteredChats,
			orders: buildSidebarChatOrderMap(allChats),
			grouping: 'project',
			currentTime: TEST_NOW,
		});

		expect(rowLabels(model)).toEqual(['header:/workspace/p1', 'normal-p1-a', 'normal-p1-b']);
		expect(model.visibleOrders.normal).toEqual(['normal-p1-a', 'normal-p1-b']);
		expect(model.reorderScopesByChatId.get('normal-p1-b')).toEqual(['normal-p1-a', 'normal-p1-b']);
	});

	it('keeps collapsed project headers while omitting their chat rows from visible anchors', () => {
		const chats = [
			chat('normal-p1-a', '/workspace/p1'),
			chat('normal-p2-a', '/workspace/p2'),
			chat('normal-p1-b', '/workspace/p1'),
			chat('archived-p1', '/workspace/p1', { isArchived: true }),
		];
		const collapsedProjectKeys = new Set([sidebarProjectKey('/workspace/p1')]);
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project',
			currentTime: TEST_NOW,
			collapsedProjectKeys,
		});

		expect(rowLabels(model)).toEqual([
			'header:/workspace/p1',
			'header:/workspace/p2',
			'normal-p2-a',
		]);
		expect(model.visibleChatIds).toEqual(['normal-p2-a']);
		expect(model.visibleOrders).toEqual({
			pinned: [],
			normal: ['normal-p2-a'],
			archived: [],
		});
		expect(model.reorderScopesByChatId.has('normal-p1-a')).toBe(false);
		expect(model.rows[0]).toMatchObject({
			type: 'project-header',
			projectKey: sidebarProjectKey('/workspace/p1'),
			count: 3,
			chatIds: ['normal-p1-a', 'normal-p1-b', 'archived-p1'],
			isCollapsed: true,
		});
	});

	it('groups nested project paths under an actual outer project path', () => {
		const chats = [
			chat('outer', '/workspace/repo'),
			chat('nested', '/workspace/repo/packages/app'),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project',
			currentTime: TEST_NOW,
			groupNestedProjectPaths: true,
		});

		expect(rowLabels(model)).toEqual(['header:/workspace/repo', 'outer', 'nested']);
		expect(model.projectKeys).toEqual([sidebarProjectKey('/workspace/repo')]);
		expect(model.rows.find((row) => row.type === 'chat' && row.chat.id === 'outer')).toMatchObject({
			groupProjectKey: sidebarProjectKey('/workspace/repo'),
			groupProjectPath: '/workspace/repo',
			showProjectPathInGroup: true,
		});
		expect(model.rows.find((row) => row.type === 'chat' && row.chat.id === 'nested')).toMatchObject(
			{
				projectPath: '/workspace/repo/packages/app',
				groupProjectKey: sidebarProjectKey('/workspace/repo'),
				groupProjectPath: '/workspace/repo',
				showProjectPathInGroup: true,
			},
		);
		expect(model.reorderScopesByChatId.get('outer')).toEqual(['outer', 'nested']);
		expect(model.reorderScopesByChatId.get('nested')).toEqual(['outer', 'nested']);
	});

	it('does not combine sibling project paths without an actual ancestor project', () => {
		const chats = [
			chat('b', '/workspace/repo/packages/b'),
			chat('c', '/workspace/repo/packages/c'),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project',
			currentTime: TEST_NOW,
			groupNestedProjectPaths: true,
		});

		expect(rowLabels(model)).toEqual([
			'header:/workspace/repo/packages/b',
			'b',
			'header:/workspace/repo/packages/c',
			'c',
		]);
		expect(model.projectKeys).toEqual([
			sidebarProjectKey('/workspace/repo/packages/b'),
			sidebarProjectKey('/workspace/repo/packages/c'),
		]);
		expect(model.rows.find((row) => row.type === 'chat' && row.chat.id === 'b')).toMatchObject({
			groupProjectPath: '/workspace/repo/packages/b',
			showProjectPathInGroup: false,
		});
		expect(model.rows.find((row) => row.type === 'chat' && row.chat.id === 'c')).toMatchObject({
			groupProjectPath: '/workspace/repo/packages/c',
			showProjectPathInGroup: false,
		});
	});

	it('uses the outermost actual ancestor as the merged group', () => {
		const chats = [
			chat('root', '/workspace/repo'),
			chat('package', '/workspace/repo/packages/app'),
			chat('src', '/workspace/repo/packages/app/src'),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project',
			currentTime: TEST_NOW,
			groupNestedProjectPaths: true,
		});

		expect(rowLabels(model)).toEqual(['header:/workspace/repo', 'root', 'package', 'src']);
		expect(model.projectKeys).toEqual([sidebarProjectKey('/workspace/repo')]);
		expect(model.rows.find((row) => row.type === 'chat' && row.chat.id === 'src')).toMatchObject({
			groupProjectPath: '/workspace/repo',
			showProjectPathInGroup: true,
		});
	});

	it('does not treat segment prefixes as ancestors', () => {
		const chats = [
			chat('exact', '/workspace/repo/app'),
			chat('prefix', '/workspace/repo/app-copy'),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project',
			currentTime: TEST_NOW,
			groupNestedProjectPaths: true,
		});

		expect(rowLabels(model)).toEqual([
			'header:/workspace/repo/app',
			'exact',
			'header:/workspace/repo/app-copy',
			'prefix',
		]);
		expect(model.projectKeys).toEqual([
			sidebarProjectKey('/workspace/repo/app'),
			sidebarProjectKey('/workspace/repo/app-copy'),
		]);
	});

	it('builds project keys from nested grouping for collapse pruning', () => {
		expect(
			buildSidebarProjectKeys({
				displayedChats: [chat('outer', '/a'), chat('nested', '/a/b')],
				groupNestedProjectPaths: true,
			}),
		).toEqual([sidebarProjectKey('/a')]);

		expect(
			buildSidebarProjectKeys({
				displayedChats: [chat('b', '/a/b'), chat('c', '/a/c')],
				groupNestedProjectPaths: true,
			}),
		).toEqual([sidebarProjectKey('/a/b'), sidebarProjectKey('/a/c')]);
	});

	it('builds display chat ids from the same row model logic', () => {
		const chats = [
			chat('normal-p2-a', '/workspace/p2'),
			chat('normal-p1-a', '/workspace/p1'),
			chat('normal-p1-b', '/workspace/p1'),
		];

		expect(
			buildSidebarDisplayChatIds({
				displayedChats: chats,
				grouping: 'project',
				currentTime: TEST_NOW,
			}),
		).toEqual(['normal-p1-a', 'normal-p1-b', 'normal-p2-a']);
		expect(
			buildSidebarDisplayChatIds({
				displayedChats: chats,
				grouping: 'project',
				currentTime: TEST_NOW,
				collapsedProjectKeys: new Set([sidebarProjectKey('/workspace/p1')]),
			}),
		).toEqual(['normal-p2-a']);
	});

	it('builds display chat ids with collapsed nested groups', () => {
		const chats = [
			chat('outer', '/workspace/repo'),
			chat('nested', '/workspace/repo/packages/app'),
			chat('other', '/workspace/other'),
		];

		expect(
			buildSidebarDisplayChatIds({
				displayedChats: chats,
				grouping: 'project',
				currentTime: TEST_NOW,
				groupNestedProjectPaths: true,
				collapsedProjectKeys: new Set([sidebarProjectKey('/workspace/repo')]),
			}),
		).toEqual(['other']);
	});
});

describe('sidebar row model with project activity grouping', () => {
	const activeActivity = new Date(TEST_NOW.getTime() - 60 * 60 * 1000).toISOString();
	const inactiveActivity = new Date(
		TEST_NOW.getTime() - SIDEBAR_INACTIVITY_DURATION_MS['3-days'] - 60 * 60 * 1000,
	).toISOString();

	function timeGroupedChats(): ChatSessionRecord[] {
		return [
			chat('active-p1', '/p1', { status: 'running', lastActivityAt: activeActivity }),
			chat('active-p2', '/p2', { status: 'running', lastActivityAt: activeActivity }),
			chat('inactive-p1', '/p1', { status: 'running', lastActivityAt: inactiveActivity }),
			chat('inactive-p2', '/p2', { status: 'running', lastActivityAt: inactiveActivity }),
			chat('pinned-old-p1', '/p1', {
				status: 'running',
				isPinned: true,
				lastActivityAt: inactiveActivity,
			}),
			chat('archived-recent-p1', '/p1', {
				status: 'running',
				isArchived: true,
				lastActivityAt: activeActivity,
			}),
			chat('archived-old-p2', '/p2', {
				status: 'running',
				isArchived: true,
				lastActivityAt: inactiveActivity,
			}),
		];
	}

	it('moves inactive and archived chats into cross-project sections', () => {
		const chats = timeGroupedChats();
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project-and-activity',
			currentTime: TEST_NOW,
		});

		expect(rowLabels(model)).toEqual([
			'header:/p1',
			'pinned-old-p1',
			'active-p1',
			'header:/p2',
			'active-p2',
			'section:inactive',
			'inactive-p1',
			'inactive-p2',
			'section:archived',
			'archived-recent-p1',
			'archived-old-p2',
		]);
		expect(model.visibleChatIds).toEqual([
			'pinned-old-p1',
			'active-p1',
			'active-p2',
			'inactive-p1',
			'inactive-p2',
			'archived-recent-p1',
			'archived-old-p2',
		]);
		expect(model.projectKeys).toEqual([sidebarProjectKey('/p1'), sidebarProjectKey('/p2')]);
		expect(
			model.rows.find((row) => row.type === 'chat' && row.chat.id === 'active-p1'),
		).toMatchObject({
			reorderScopeKey: 'normal:project:path:/p1',
			showProjectPathInGroup: false,
		});
		expect(
			model.rows.find((row) => row.type === 'chat' && row.chat.id === 'inactive-p2'),
		).toMatchObject({
			list: 'normal',
			reorderScopeKey: 'normal:section:inactive',
			showProjectPathInGroup: true,
		});
		expect(
			model.rows.find((row) => row.type === 'chat' && row.chat.id === 'archived-old-p2'),
		).toMatchObject({
			list: 'archived',
			reorderScopeKey: 'archived:section:archived',
			showProjectPathInGroup: true,
		});
		expect(model.reorderScopesByChatId.get('inactive-p1')).toEqual(['inactive-p1', 'inactive-p2']);
		expect(model.reorderScopesByChatId.get('archived-recent-p1')).toEqual([
			'archived-recent-p1',
			'archived-old-p2',
		]);
		expect(model.visibleOrders).toEqual({
			pinned: ['pinned-old-p1'],
			normal: ['active-p1', 'active-p2', 'inactive-p1', 'inactive-p2'],
			archived: ['archived-recent-p1', 'archived-old-p2'],
		});
		});

	it('groups all chats by activity while preserving persisted order boundaries', () => {
		const chats = timeGroupedChats();
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'activity',
			currentTime: TEST_NOW,
		});

		expect(rowLabels(model)).toEqual([
			'section:active',
			'pinned-old-p1',
			'active-p1',
			'active-p2',
			'section:inactive',
			'inactive-p1',
			'inactive-p2',
			'section:archived',
			'archived-recent-p1',
			'archived-old-p2',
		]);
		expect(model.projectKeys).toEqual([]);
		expect(
			model.rows.find((row) => row.type === 'chat' && row.chat.id === 'pinned-old-p1'),
		).toMatchObject({
			list: 'pinned',
			reorderScopeKey: 'pinned:section:active',
			reorderScopeIds: ['pinned-old-p1'],
			showProjectPathInGroup: true,
		});
		expect(
			model.rows.find((row) => row.type === 'chat' && row.chat.id === 'active-p1'),
		).toMatchObject({
			list: 'normal',
			reorderScopeKey: 'normal:section:active',
			reorderScopeIds: ['active-p1', 'active-p2'],
			showProjectPathInGroup: true,
		});
		expect(model.rows[0]).toMatchObject({
			type: 'section-header',
			section: 'active',
			count: 3,
			chatIds: ['pinned-old-p1', 'active-p1', 'active-p2'],
		});
		expect(model.visibleOrders).toEqual({
			pinned: ['pinned-old-p1'],
			normal: ['active-p1', 'active-p2', 'inactive-p1', 'inactive-p2'],
			archived: ['archived-recent-p1', 'archived-old-p2'],
		});
	});

	it('uses the configured inactivity boundary', () => {
		expect(
			sidebarActivitySection(
				{
					id: 'boundary',
					status: 'running',
					isPinned: false,
					isArchived: false,
					lastActivityAt: new Date(
						TEST_NOW.getTime() - SIDEBAR_INACTIVITY_DURATION_MS['2-weeks'],
					).toISOString(),
					createdAt: '2025-01-01T00:00:00.000Z',
				},
				TEST_NOW,
				'2-weeks',
			),
		).toBe('inactive');
		expect(
			sidebarActivitySection(
				{
					id: 'just-active',
					status: 'running',
					isPinned: false,
					isArchived: false,
					lastActivityAt: new Date(
						TEST_NOW.getTime() - SIDEBAR_INACTIVITY_DURATION_MS['2-weeks'] + 1,
					).toISOString(),
					createdAt: '2025-01-01T00:00:00.000Z',
				},
				TEST_NOW,
				'2-weeks',
			),
		).toBe('active');
	});

	it('uses fixed 30-day elapsed month durations', () => {
		const dayMs = 24 * 60 * 60 * 1000;
		expect(SIDEBAR_INACTIVITY_DURATION_MS['1-month']).toBe(30 * dayMs);
		expect(SIDEBAR_INACTIVITY_DURATION_MS['2-months']).toBe(60 * dayMs);
		expect(SIDEBAR_INACTIVITY_DURATION_MS['3-months']).toBe(90 * dayMs);
	});

	it('falls back to creation time and counts missing timestamps as inactive', () => {
		expect(
			sidebarActivitySection(
				{
					id: 'created-recently',
					status: 'running',
					isPinned: false,
					isArchived: false,
					lastActivityAt: null,
					createdAt: activeActivity,
				},
				TEST_NOW,
				TEST_INACTIVITY_DURATION,
			),
		).toBe('active');
		expect(
			sidebarActivitySection(
				{
					id: 'no-timestamps',
					status: 'running',
					isPinned: false,
					isArchived: false,
					lastActivityAt: null,
					createdAt: null,
				},
				TEST_NOW,
				TEST_INACTIVITY_DURATION,
			),
		).toBe('inactive');
	});

	it('classifies timestamp-less local drafts as active', () => {
		expect(
			sidebarActivitySection(
				{
					id: 'local-draft',
					status: 'draft',
					isPinned: false,
					isArchived: false,
					lastActivityAt: null,
					createdAt: null,
				},
				TEST_NOW,
				TEST_INACTIVITY_DURATION,
			),
		).toBe('active');
	});

	it('keeps pinned chats in their project group and archived chats out of the inactive section', () => {
		expect(
			sidebarActivitySection(
				{
					id: 'pinned-old',
					status: 'running',
					isPinned: true,
					isArchived: false,
					lastActivityAt: inactiveActivity,
					createdAt: '2025-01-01T00:00:00.000Z',
				},
				TEST_NOW,
				TEST_INACTIVITY_DURATION,
			),
		).toBe('active');
		expect(
			sidebarActivitySection(
				{
					id: 'pinned-archived-overlap',
					status: 'running',
					isPinned: true,
					isArchived: true,
					lastActivityAt: inactiveActivity,
					createdAt: '2025-01-01T00:00:00.000Z',
				},
				TEST_NOW,
				TEST_INACTIVITY_DURATION,
			),
		).toBe('active');
		expect(
			sidebarActivitySection(
				{
					id: 'archived-old',
					status: 'running',
					isPinned: false,
					isArchived: true,
					lastActivityAt: inactiveActivity,
					createdAt: '2025-01-01T00:00:00.000Z',
				},
				TEST_NOW,
				TEST_INACTIVITY_DURATION,
			),
		).toBe('archived');
	});

	it('omits empty sections and hides collapsed section chats from visible anchors', () => {
		const chats = [
			chat('active-p1', '/p1', { status: 'running', lastActivityAt: activeActivity }),
			chat('inactive-p1', '/p1', { status: 'running', lastActivityAt: inactiveActivity }),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project-and-activity',
			currentTime: TEST_NOW,
			collapsedProjectKeys: new Set(['section:inactive']),
		});

		expect(rowLabels(model)).toEqual(['header:/p1', 'active-p1', 'section:inactive']);
		expect(model.visibleChatIds).toEqual(['active-p1']);
		expect(model.visibleOrders).toEqual({
			pinned: [],
			normal: ['active-p1'],
			archived: [],
		});
		expect(model.rows[2]).toMatchObject({
			type: 'section-header',
			section: 'inactive',
			count: 1,
			chatIds: ['inactive-p1'],
			isCollapsed: true,
		});
	});

	it('omits project groups whose chats all moved to sections', () => {
		const chats = [
			chat('active-p1', '/p1', { status: 'running', lastActivityAt: activeActivity }),
			chat('inactive-p2', '/p2', { status: 'running', lastActivityAt: inactiveActivity }),
		];
		const model = buildSidebarRowModel({
			displayedChats: chats,
			orders: buildSidebarChatOrderMap(chats),
			grouping: 'project-and-activity',
			currentTime: TEST_NOW,
		});

		expect(rowLabels(model)).toEqual([
			'header:/p1',
			'active-p1',
			'section:inactive',
			'inactive-p2',
		]);
		expect(model.projectKeys).toEqual([sidebarProjectKey('/p1')]);
	});

	it('builds display chat ids with activity sections', () => {
		const chats = timeGroupedChats();
		expect(
			buildSidebarDisplayChatIds({
				displayedChats: chats,
				grouping: 'project-and-activity',
				currentTime: TEST_NOW,
			}),
		).toEqual([
			'pinned-old-p1',
			'active-p1',
			'active-p2',
			'inactive-p1',
			'inactive-p2',
			'archived-recent-p1',
			'archived-old-p2',
		]);
		expect(
			buildSidebarDisplayChatIds({
				displayedChats: chats,
				grouping: 'project-and-activity',
				currentTime: TEST_NOW,
				collapsedProjectKeys: new Set(['section:archived']),
			}),
		).toEqual([
			'pinned-old-p1',
			'active-p1',
			'active-p2',
			'inactive-p1',
			'inactive-p2',
		]);
	});
});
