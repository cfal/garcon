import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { ChatActionDialogsState } from '../chat-action-dialogs-state.svelte';

function makeChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Chat',
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
		isUnread: false,
		status: 'draft',
		tags: [],
		...overrides,
	};
}

describe('ChatActionDialogsState', () => {
	it('derives every dialog payload from one chat record shape', () => {
		const dialogs = new ChatActionDialogsState();
		const chat = makeChat({ title: '', projectPath: '/workspace/repo', tags: ['review'] });

		dialogs.requestDelete(chat, 'New chat');
		dialogs.requestRename(chat, 'New chat');
		dialogs.requestProjectPath(chat, 'New chat');
		dialogs.requestDetails(chat, 'New chat');
		dialogs.requestTags(chat, 'New chat');
		dialogs.requestShare(chat, 'New chat');

		expect(dialogs.chatDeleteConfirmation).toMatchObject({
			chatId: chat.id,
			chatTitle: 'New chat',
			agentId: chat.agentId,
		});
		expect(dialogs.chatRenameConfirmation).toEqual({
			chatId: chat.id,
			currentName: 'New chat',
		});
		expect(dialogs.chatProjectPathDialog).toEqual({
			chatId: chat.id,
			chatTitle: 'New chat',
			currentProjectPath: '/workspace/repo',
		});
		expect(dialogs.chatDetailsDialog).toMatchObject({
			chatId: chat.id,
			chatTitle: 'New chat',
			isLoading: true,
		});
		expect(dialogs.tagDialog).toEqual({
			chatId: chat.id,
			chatTitle: 'New chat',
			tags: ['review'],
		});
		expect(dialogs.shareChatDialog).toEqual({ chatId: chat.id, chatTitle: 'New chat' });
	});

	it('ignores stale details completion after another chat opens', () => {
		const dialogs = new ChatActionDialogsState();
		dialogs.requestDetails(makeChat({ id: 'c1', title: 'First' }), 'New chat');
		dialogs.requestDetails(makeChat({ id: 'c2', title: 'Second' }), 'New chat');

		dialogs.completeDetails('c1', {
			firstMessage: 'stale',
			createdAt: '2026-01-01',
			lastActivityAt: '2026-01-02',
			agentSessionId: 'stale-session',
		});

		expect(dialogs.chatDetailsDialog?.chatId).toBe('c2');
		expect(dialogs.chatDetailsDialog?.firstMessage).toBeNull();
		expect(dialogs.chatDetailsDialog?.agentSessionId).toBeNull();
	});
});
