import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarChatListHost from './SidebarChatListHost.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(index: number): ChatSessionRecord {
	return {
		id: `chat-${index}`,
		projectPath: '/tmp/project',
		effectiveProjectKey: '/tmp/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: `Chat ${index}`,
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'low',
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'draft',
		lastMessage: `Chat ${index} preview`,
		tags: [],
		firstMessage: `Chat ${index} first`,
		parentChat: null,
		agentOwnershipEpoch: null,
	};
}

describe('SidebarChatList empty states', () => {
	it('shows the no-chats state with a New Chat action when the workspace is empty', async () => {
		const onNewChat = vi.fn();
		render(SidebarChatListHost, { props: { chats: [], onNewChat } });

		expect(screen.getByText('No chats yet')).toBeTruthy();
		expect(screen.getByText('Create your first chat to get started.')).toBeTruthy();
		expect(screen.queryByText('No matching chats')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'New Chat' }));
		expect(onNewChat).toHaveBeenCalledTimes(1);
	});

	it('omits the New Chat action when no handler is provided', () => {
		render(SidebarChatListHost, { props: { chats: [] } });

		expect(screen.getByText('No chats yet')).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'New Chat' })).toBeNull();
	});

	it('shows the search-empty state only when a filter is active', () => {
		render(SidebarChatListHost, {
			props: { chats: [makeChat(1)], filteredChats: [], searchFilter: 'zzz' },
		});

		expect(screen.getByText('No matching chats')).toBeTruthy();
		expect(screen.queryByText('No chats yet')).toBeNull();
	});

	it('renders rows when chats exist', () => {
		render(SidebarChatListHost, { props: { chats: [makeChat(1)] } });

		expect(screen.queryByText('No chats yet')).toBeNull();
		expect(screen.queryByText('No matching chats')).toBeNull();
		expect(screen.getByText('Chat 1')).toBeTruthy();
	});
});
