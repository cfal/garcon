import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { buildSidebarDisplayChatIds } from '$lib/components/sidebar/sidebar-row-model';
import { resolveAdjacentChatId, shouldSynchronizeFocusedChat } from '../app-shell-chat-navigation';

function chat(
	id: string,
	options: Partial<
		Pick<ChatSessionRecord, 'isPinned' | 'isArchived' | 'lastActivityAt'>
	> = {},
): ChatSessionRecord {
	return {
		id,
		parentChat: null,
		projectPath: '/repo',
		orderGroup: 'normal',
		title: id,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: options.lastActivityAt ?? null,
		lastReadAt: null,
		isPinned: options.isPinned ?? false,
		isArchived: options.isArchived ?? false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		agentOwnershipEpoch: 'epoch-1',
		tags: [],
	};
}

describe('resolveAdjacentChatId', () => {
	it('follows displayed sidebar order when pinned chats are hoisted', () => {
		const chats = [chat('normal-a'), chat('normal-b'), chat('pinned-c', { isPinned: true })];
		const displayedChatIds = buildSidebarDisplayChatIds({
			displayedChats: chats,
			grouping: 'none',
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			inactivityDuration: '3-days',
			sortMode: 'manual',
		});

		expect(displayedChatIds).toEqual(['pinned-c', 'normal-a', 'normal-b']);
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'normal-a',
				displayedChatIds,
				fallbackOrder: ['normal-a', 'normal-b', 'pinned-c'],
				offset: -1,
			}),
		).toBe('pinned-c');
	});

	it('follows activity sections and the configured inactivity duration', () => {
		const chats = [
			chat('inactive-a'),
			chat('active-b', { lastActivityAt: '2025-05-22T12:00:00.000Z' }),
			chat('pinned-c', { isPinned: true }),
			chat('archived-d', { isArchived: true }),
		];
		const input = {
			displayedChats: chats,
			grouping: 'activity',
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			sortMode: 'manual',
		} as const;

		expect(
			buildSidebarDisplayChatIds({ ...input, inactivityDuration: '2-weeks' }),
		).toEqual(['pinned-c', 'active-b', 'inactive-a', 'archived-d']);
		expect(buildSidebarDisplayChatIds({ ...input, inactivityDuration: '5-days' })).toEqual([
			'pinned-c',
			'inactive-a',
			'active-b',
			'archived-d',
		]);
	});

	it('follows recent activity order within an activity section', () => {
		const displayedChatIds = buildSidebarDisplayChatIds({
			displayedChats: [
				chat('older', { lastActivityAt: '2025-05-30T12:00:00.000Z' }),
				chat('newer', { lastActivityAt: '2025-05-31T12:00:00.000Z' }),
			],
			grouping: 'activity',
			currentTime: new Date('2025-06-01T12:00:00.000Z'),
			inactivityDuration: '3-days',
			sortMode: 'recent',
		});

		expect(displayedChatIds).toEqual(['newer', 'older']);
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'newer',
				displayedChatIds,
				fallbackOrder: ['older', 'newer'],
				offset: 1,
			}),
		).toBe('older');
	});

	it('falls back to raw session order when the sidebar is unmounted', () => {
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'normal-b',
				displayedChatIds: null,
				fallbackOrder: ['normal-a', 'normal-b', 'pinned-c'],
				offset: -1,
			}),
		).toBe('normal-a');
	});

	it('does not fall back when the mounted sidebar has filtered out the selected chat', () => {
		expect(
			resolveAdjacentChatId({
				selectedChatId: 'normal-a',
				displayedChatIds: ['normal-b'],
				fallbackOrder: ['normal-a', 'normal-b'],
				offset: 1,
			}),
		).toBeNull();
	});
});

describe('shouldSynchronizeFocusedChat', () => {
	it('does not let stale focus replace an explicit Chat navigation in flight', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-main',
				focusedChatId: 'chat-old',
				focusedChatExists: true,
				selectedChatId: null,
				pendingChatTarget: 'chat-route',
				pendingWindowId: 'window-main',
			}),
		).toBe(false);
	});

	it('lets a newly focused window supersede an older navigation in flight', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-other',
				focusedChatId: 'chat-focused',
				focusedChatExists: true,
				selectedChatId: 'chat-selected',
				pendingChatTarget: 'chat-route',
				pendingWindowId: 'window-main',
			}),
		).toBe(true);
	});

	it('synchronizes a changed focused Chat after explicit navigation settles', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-main',
				focusedChatId: 'chat-focused',
				focusedChatExists: true,
				selectedChatId: 'chat-selected',
				pendingChatTarget: null,
				pendingWindowId: null,
			}),
		).toBe(true);
	});

	it('does not reselect a focused Chat after its session is deleted', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedWindowId: 'window-main',
				focusedChatId: 'chat-deleted',
				focusedChatExists: false,
				selectedChatId: null,
				pendingChatTarget: null,
				pendingWindowId: null,
			}),
		).toBe(false);
	});
});
