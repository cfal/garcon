import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { SidebarBulkDeleteState } from '../sidebar-bulk-delete-state.svelte';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
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

describe('SidebarBulkDeleteState', () => {
	it('builds a confirmation from selected chats', () => {
		const bulkDelete = new SidebarBulkDeleteState();

		bulkDelete.request(
			[makeChat({ id: 'c1', title: 'Named' }), makeChat({ id: 'c2', title: '' })],
			'Unnamed',
		);

		expect(bulkDelete.confirmation).toEqual({
			chatIds: ['c1', 'c2'],
			chatTitles: ['Named', 'Unnamed'],
		});
	});
});
