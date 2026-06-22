import { describe, expect, it } from 'vitest';

import { SidebarDialogsState } from '../sidebar-dialogs-state.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/tmp/project',
		title: 'Chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
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

describe('SidebarDialogsState', () => {
	it('builds bulk delete confirmation from selected chats', () => {
		const dialogs = new SidebarDialogsState();

		dialogs.requestBulkDelete(
			[makeChat({ id: 'c1', title: 'Named' }), makeChat({ id: 'c2', title: '' })],
			'Unnamed',
		);

		expect(dialogs.bulkDeleteConfirmation).toEqual({
			chatIds: ['c1', 'c2'],
			chatTitles: ['Named', 'Unnamed'],
		});
	});

	it('ignores stale details completion after another chat opens', () => {
		const dialogs = new SidebarDialogsState();

		dialogs.showDetails('c1', 'First');
		dialogs.showDetails('c2', 'Second');
		dialogs.completeDetails('c1', {
			firstMessage: 'stale',
			createdAt: '2026-01-01',
			lastActivityAt: '2026-01-02',
			agentSessionId: 'stale-session',
			nativePath: '/tmp/stale',
		});

		expect(dialogs.chatDetailsDialog?.chatId).toBe('c2');
		expect(dialogs.chatDetailsDialog?.firstMessage).toBeNull();
		expect(dialogs.chatDetailsDialog?.agentSessionId).toBeNull();
	});
});
