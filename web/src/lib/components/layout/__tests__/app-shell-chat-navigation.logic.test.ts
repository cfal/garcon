import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { buildSidebarDisplayChatIds } from '$lib/components/sidebar/sidebar-row-model';
import {
	resolveAdjacentChatId,
	shouldSynchronizeFocusedChat,
} from '../app-shell-chat-navigation';

function chat(
	id: string,
	options: Partial<Pick<ChatSessionRecord, 'isPinned' | 'isArchived'>> = {},
): ChatSessionRecord {
	return {
		id,
		projectPath: '/repo',
		effectiveProjectKey: '/repo',
		projectIdentityState: 'available',
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
			groupByProject: false,
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
				focusedChatId: 'chat-old',
				focusedChatExists: true,
				selectedChatId: null,
				pendingChatTarget: 'chat-route',
			}),
		).toBe(false);
	});

	it('synchronizes a changed focused Chat after explicit navigation settles', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedChatId: 'chat-focused',
				focusedChatExists: true,
				selectedChatId: 'chat-selected',
				pendingChatTarget: null,
			}),
		).toBe(true);
	});

	it('does not reselect a focused Chat after its session is deleted', () => {
		expect(
			shouldSynchronizeFocusedChat({
				focusedChatId: 'chat-deleted',
				focusedChatExists: false,
				selectedChatId: null,
				pendingChatTarget: null,
			}),
		).toBe(false);
	});
});
