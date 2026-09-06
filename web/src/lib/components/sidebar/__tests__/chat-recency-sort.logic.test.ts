import { describe, expect, it } from 'vitest';
import { chatActivityTimeMs } from '$shared/chat-order-sort';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { isSidebarChatInactive } from '../chat-inactivity';
import { sortChatsByRecencyDesc, sortSidebarChatsByRecency } from '../chat-recency-sort';

// 16-digit Unix-microsecond chat ids as minted by the browser clock.
function chatIdAt(epochMs: number): string {
	return String(BigInt(epochMs) * 1000n).padStart(16, '0');
}

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

	it('ranks timestamp-less local drafts ahead of server chats', () => {
		const chats = [
			makeChat('recent', {
				status: 'running',
				lastActivityAt: '2026-03-01T00:00:00.000Z',
			}),
			makeChat('draft', { status: 'draft' }),
			makeChat('older', {
				status: 'running',
				lastActivityAt: '2026-01-01T00:00:00.000Z',
			}),
		];

		expect(sortChatsByRecencyDesc(chats).map((chat) => chat.id)).toEqual([
			'draft',
			'recent',
			'older',
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

	it('orders a timestamp-less chat by the creation time embedded in its id', () => {
		const chats = [
			makeChat(chatIdAt(Date.UTC(2026, 8, 3, 9, 0)), {}),
			makeChat('older', { lastActivityAt: '2026-08-01T00:00:00.000Z' }),
			makeChat('newer', { lastActivityAt: '2026-09-10T00:00:00.000Z' }),
		];

		expect(sortChatsByRecencyDesc(chats).map((chat) => chat.id)).toEqual([
			'newer',
			chatIdAt(Date.UTC(2026, 8, 3, 9, 0)),
			'older',
		]);
	});

	it('keeps a chat above clock-inverted server timestamps via its id', () => {
		const chats = [
			// Server clock stepped backward: projected activity predates every
			// other chat, but the id still carries the browser creation time.
			makeChat(chatIdAt(Date.UTC(2026, 8, 3, 9, 0)), {
				createdAt: '2026-01-01T00:00:00.000Z',
				lastActivityAt: '2026-01-01T00:00:00.000Z',
			}),
			makeChat('older', { lastActivityAt: '2026-08-01T00:00:00.000Z' }),
		];

		expect(sortChatsByRecencyDesc(chats).map((chat) => chat.id)).toEqual([
			chatIdAt(Date.UTC(2026, 8, 3, 9, 0)),
			'older',
		]);
	});

	it('returns zero when no timestamp source is parsable', () => {
		expect(chatActivityTimeMs(makeChat('legacy-id', {}))).toBe(0);
	});

	it('ignores a shaped but invalid chat id instead of throwing', () => {
		const chats = [makeChat('0000000000000000', {}), makeChat('9100000000000000', {})];
		expect(() => sortChatsByRecencyDesc(chats)).not.toThrow();
		expect(chatActivityTimeMs(makeChat('0000000000000000', {}))).toBe(0);
	});

	it('orders by creation time when it postdates the recorded activity', () => {
		const chats = [
			makeChat('a', { createdAt: '2026-03-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' }),
			makeChat('b', { createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-02-01T00:00:00.000Z' }),
		];

		expect(sortChatsByRecencyDesc(chats).map((chat) => chat.id)).toEqual(['a', 'b']);
	});
});

describe('sortSidebarChatsByRecency', () => {
	it('puts only the pinned subset oldest-first when pins are added at the bottom', () => {
		const chats = [
			makeChat('pinned-new', {
				isPinned: true,
				lastActivityAt: '2026-04-01T00:00:00.000Z',
			}),
			makeChat('normal-old', { lastActivityAt: '2026-01-01T00:00:00.000Z' }),
			makeChat('archived-new', {
				isArchived: true,
				lastActivityAt: '2026-06-01T00:00:00.000Z',
			}),
			makeChat('pinned-old', {
				isPinned: true,
				lastActivityAt: '2026-02-01T00:00:00.000Z',
			}),
			makeChat('normal-new', { lastActivityAt: '2026-05-01T00:00:00.000Z' }),
			makeChat('archived-old', {
				isArchived: true,
				lastActivityAt: '2026-03-01T00:00:00.000Z',
			}),
		];
		const originalOrder = chats.map((chat) => chat.id);

		const sorted = sortSidebarChatsByRecency(chats, 'bottom');

		expect(sorted.filter((chat) => chat.isPinned).map((chat) => chat.id)).toEqual([
			'pinned-old',
			'pinned-new',
		]);
		expect(
			sorted.filter((chat) => !chat.isPinned && !chat.isArchived).map((chat) => chat.id),
		).toEqual(['normal-new', 'normal-old']);
		expect(sorted.filter((chat) => chat.isArchived).map((chat) => chat.id)).toEqual([
			'archived-new',
			'archived-old',
		]);
		expect(chats.map((chat) => chat.id)).toEqual(originalOrder);
	});

	it('keeps stable pinned ties while placing pinned drafts last', () => {
		const chats = [
			makeChat('pinned-a', { isPinned: true }),
			makeChat('pinned-b', { isPinned: true }),
			makeChat('pinned-draft', { isPinned: true, status: 'draft' }),
		];

		expect(sortSidebarChatsByRecency(chats, 'bottom').map((chat) => chat.id)).toEqual([
			'pinned-a',
			'pinned-b',
			'pinned-draft',
		]);
	});
});

describe('isSidebarChatInactive', () => {
	it('classifies timestamp-less chats by the creation time embedded in their id', () => {
		const now = new Date('2026-09-03T12:00:00.000Z');

		expect(
			isSidebarChatInactive(makeChat(chatIdAt(Date.UTC(2026, 8, 3, 9, 0)), {}), now, '3-days'),
		).toBe(false);
		expect(
			isSidebarChatInactive(makeChat(chatIdAt(Date.UTC(2026, 7, 1, 9, 0)), {}), now, '3-days'),
		).toBe(true);
	});
});
