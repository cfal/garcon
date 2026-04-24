import { describe, expect, it } from 'vitest';

import { getWorkspaceName, groupChatsByWorkspace } from '../workspace-group.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/some/workspace',
		title: 'Chat',
		provider: 'claude',
		model: null,
		permissionMode: 'default',
		thinkingMode: 'think',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'draft',
		tags: [],
			...overrides,
	};
}

describe('getWorkspaceName', () => {
	it('returns the deepest directory as workspace name', () => {
		expect(getWorkspaceName('/workspace/garcon/chat1')).toBe('chat1');
	});

	it('returns the basename for a single-level path', () => {
		expect(getWorkspaceName('myproject')).toBe('myproject');
	});

	it('returns Unassigned for empty path', () => {
		expect(getWorkspaceName('')).toBe('Unassigned');
	});

	it('returns Unassigned for whitespace-only path', () => {
		expect(getWorkspaceName('      ')).toBe('Unassigned');
	});

	it('returns the last segment for a two-level path', () => {
		expect(getWorkspaceName('/workspace/garcon')).toBe('garcon');
	});
});

describe('groupChatsByWorkspace', () => {
	it('groups chats by their deepest directory', () => {
		const chats = [
			makeChat({ id: '1', projectPath: '/workspace/garcon' }),
			makeChat({ id: '2', projectPath: '/workspace/garcon' }),
			makeChat({ id: '3', projectPath: '/workspace/pm5' }),
			makeChat({ id: '4', projectPath: '/workspace/garcon' }),
			];

		const groups = groupChatsByWorkspace(chats);

		expect(groups).toHaveLength(2);
		expect(groups[0].name).toBe('garcon');
		expect(groups[0].chats).toHaveLength(3);
		expect(groups[1].name).toBe('pm5');
		expect(groups[1].chats).toHaveLength(1);
	});

	it('groups separate workspace basenames independently', () => {
		const chats = [
			makeChat({ id: '1', projectPath: '/workspace/pm5' }),
			makeChat({ id: '2', projectPath: '/workspace/garcon' }),
			makeChat({ id: '3', projectPath: '/workspace/pm5' }),
			];

		const groups = groupChatsByWorkspace(chats);

		expect(groups[0].name).toBe('pm5');
		expect(groups[0].chats.map((c) => c.id)).toEqual(['1', '3']);
		expect(groups[1].name).toBe('garcon');
		expect(groups[1].chats.map((c) => c.id)).toEqual(['2']);
	});

	it('groups different paths with the same basename together', () => {
		const chats = [
			makeChat({ id: '1', projectPath: '/workspace/garcon/sub' }),
			makeChat({ id: '2', projectPath: '/other/garcon/sub' }),
			];

		const groups = groupChatsByWorkspace(chats);

		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe('sub');
		expect(groups[0].chats.map((c) => c.id)).toEqual(['1', '2']);
	});

	it('preserves original chat order within each group', () => {
		const chats = [
			makeChat({ id: '1', projectPath: '/workspace/garcon' }),
			makeChat({ id: '2', projectPath: '/workspace/garcon' }),
			makeChat({ id: '3', projectPath: '/workspace/garcon' }),
			];

		const groups = groupChatsByWorkspace(chats);

		expect(groups).toHaveLength(1);
		expect(groups[0].chats.map((c) => c.id)).toEqual(['1', '2', '3']);
	});

	it('handles empty chat list', () => {
		expect(groupChatsByWorkspace([])).toEqual([]);
	});

	it('groups empty projectPath chats under Unassigned', () => {
		const chats = [
			makeChat({ id: '1', projectPath: '/workspace/garcon' }),
			makeChat({ id: '2', projectPath: '' }),
			makeChat({ id: '3', projectPath: '' }),
			];

		const groups = groupChatsByWorkspace(chats);

		expect(groups).toHaveLength(2);
		expect(groups[0].name).toBe('garcon');
		expect(groups[1].name).toBe('Unassigned');
		expect(groups[1].chats).toHaveLength(2);
	});
});
