import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { sortChatsByRecencyDesc } from '../chat-recency-sort';

function makeChat(id: string, activity: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id,
		projectPath: '/tmp/project',
		title: id,
		agentId: 'claude',
		model: 'claude',
		apiProviderId: null,
		modelEndpointId: null,
		modelProtocol: null,
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: null,
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'running',
		tags: [],
		...activity,
	} as ChatSessionRecord;
}

describe('sortChatsByRecencyDesc', () => {
	it('orders chats newest-first by last activity', () => {
		const chats = [
			makeChat('old', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
			makeChat('new', { lastActivityAt: '2026-03-01T00:00:00.000Z' }),
			makeChat('mid', { lastActivityAt: '2026-02-01T00:00:00.000Z' }),
		];

		expect(sortChatsByRecencyDesc(chats).map((c) => c.id)).toEqual(['new', 'mid', 'old']);
	});

	it('falls back to creation time when activity is missing', () => {
		const chats = [
			makeChat('created-first', { createdAt: '2026-01-01T00:00:00.000Z' }),
			makeChat('active', { lastActivityAt: '2026-02-15T00:00:00.000Z' }),
			makeChat('created-later', { createdAt: '2026-02-01T00:00:00.000Z' }),
		];

		expect(sortChatsByRecencyDesc(chats).map((c) => c.id)).toEqual([
			'active',
			'created-later',
			'created-first',
		]);
	});

	it('does not mutate the source array', () => {
		const chats = [
			makeChat('a', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
			makeChat('b', { lastActivityAt: '2026-02-01T00:00:00.000Z' }),
		];
		const originalOrder = chats.map((c) => c.id);

		sortChatsByRecencyDesc(chats);

		expect(chats.map((c) => c.id)).toEqual(originalOrder);
	});
});
