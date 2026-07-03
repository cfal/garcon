import { describe, expect, it } from 'vitest';
import {
	buildSidebarChatOrderMap,
	buildSidebarDisplayChatIds,
	buildSidebarRowModel,
	sidebarProjectKey,
} from '../sidebar-row-model';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function chat(
	id: string,
	projectPath: string,
	overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord {
	return {
		id,
		projectPath,
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'low',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		lastMessage: '',
		tags: [],
		firstMessage: '',
		...overrides,
	};
}

function rowLabels(model: ReturnType<typeof buildSidebarRowModel>): string[] {
	return model.rows.map((row) => (row.type === 'project-header' ? `header:${row.projectPath}` : row.chat.id));
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
			groupByProject: false,
		});

		expect(rowLabels(model)).toEqual(['pinned-a', 'normal-a', 'normal-b', 'archived-a']);
		expect(model.visibleChatIds).toEqual(['pinned-a', 'normal-a', 'normal-b', 'archived-a']);
		expect(model.visibleOrders).toEqual({
			pinned: ['pinned-a'],
			normal: ['normal-a', 'normal-b'],
			archived: ['archived-a'],
		});
		expect(model.reorderScopesByChatId.get('normal-a')).toEqual(['normal-a', 'normal-b']);
		expect(model.rows.find((row) => row.type === 'chat' && row.chat.id === 'normal-a')).toMatchObject({
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
			groupByProject: true,
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
		expect(model.reorderScopesByChatId.get('normal-p1-a')).toEqual([
			'normal-p1-a',
			'normal-p1-b',
		]);
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
			groupByProject: true,
		});

		expect(rowLabels(model)).toEqual(['header:/workspace/p1', 'normal-p1-a', 'normal-p1-b']);
		expect(model.visibleOrders.normal).toEqual(['normal-p1-a', 'normal-p1-b']);
		expect(model.reorderScopesByChatId.get('normal-p1-b')).toEqual([
			'normal-p1-a',
			'normal-p1-b',
		]);
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
			groupByProject: true,
			collapsedProjectKeys,
		});

		expect(rowLabels(model)).toEqual(['header:/workspace/p1', 'header:/workspace/p2', 'normal-p2-a']);
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

	it('builds display chat ids from the same row model logic', () => {
		const chats = [
			chat('normal-p2-a', '/workspace/p2'),
			chat('normal-p1-a', '/workspace/p1'),
			chat('normal-p1-b', '/workspace/p1'),
		];

		expect(buildSidebarDisplayChatIds({ displayedChats: chats, groupByProject: true })).toEqual([
			'normal-p1-a',
			'normal-p1-b',
			'normal-p2-a',
		]);
		expect(
			buildSidebarDisplayChatIds({
				displayedChats: chats,
				groupByProject: true,
				collapsedProjectKeys: new Set([sidebarProjectKey('/workspace/p1')]),
			}),
		).toEqual(['normal-p2-a']);
	});
});
