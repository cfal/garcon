import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { ChatBoard } from '$shared/chat-boards';
import { projectChatBoard } from '../projection/chat-board-projection';

const board: ChatBoard = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Delivery',
	columns: [
		{
			id: '22222222-2222-4222-8222-222222222222',
			name: 'Ready',
			match: 'all',
			tags: ['frontend', 'ready'],
		},
		{
			id: '33333333-3333-4333-8333-333333333333',
			name: 'Attention',
			match: 'any',
			tags: ['blocked', 'ready'],
		},
	],
};

function chat(id: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: `/workspace/${id}`,
		orderGroup: 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		canReloadFromNativeHistory: false,
		isUnread: false,
		status: 'running',
		agentOwnershipEpoch: null,
		tags: [],
		...overrides,
	};
}

describe('projectChatBoard', () => {
	it('preserves canonical order and allows duplicate column membership', () => {
		const lanes = projectChatBoard(board, [
			chat('first', { tags: ['frontend', 'ready'], isProcessing: true }),
			chat('second', { tags: ['blocked'] }),
			chat('third', { tags: ['frontend', 'ready'] }),
		]);

		expect(lanes[0].occurrences.map((item) => item.chat.id)).toEqual(['first', 'third']);
		expect(lanes[1].occurrences.map((item) => item.chat.id)).toEqual(['first', 'second', 'third']);
		expect(lanes[0].occurrences[0].key).toBe(`${board.columns[0].id}:first`);
		expect(lanes[0].processingCount).toBe(1);
	});

	it('excludes drafts and archived chats across projects', () => {
		const lanes = projectChatBoard(board, [
			chat('draft', { status: 'draft', tags: ['frontend', 'ready'] }),
			chat('archived', { isArchived: true, tags: ['frontend', 'ready'] }),
			chat('eligible', { projectPath: '/another/project', tags: ['frontend', 'ready'] }),
		]);

		expect(lanes[0].occurrences.map((item) => item.chat.id)).toEqual(['eligible']);
	});

	it('uses isProcessing rather than the persisted running status', () => {
		const lanes = projectChatBoard(board, [
			chat('idle-running', { status: 'running', tags: ['frontend', 'ready'] }),
		]);
		expect(lanes[0].processingCount).toBe(0);
	});
});
