import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarChatItemHarness from './SidebarChatItemHarness.svelte';
import SidebarSearchDialogHarness from './SidebarSearchDialogHarness.svelte';

import type { ChatSessionRecord } from '$lib/types/chat-session';

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/very/long/workspace/projects/feature-branch/app',
		title: 'Shared row chat',
		provider: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'think',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: '2025-01-01T00:00:00.000Z',
		lastActivityAt: '2025-01-01T00:00:00.000Z',
		lastReadAt: '2025-01-01T00:00:00.000Z',
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: true,
		status: 'draft',
		lastMessage: 'Latest preview text',
		tags: ['ops', 'prod', 'urgent'],
		firstMessage: 'First message',
		...overrides,
	};
}

describe('shared sidebar chat row', () => {
	it('renders the shared chat summary inside the sidebar item shell', async () => {
		const onTagClick = vi.fn();
		const onManageTags = vi.fn();

		render(SidebarChatItemHarness, {
			session: createChat(),
			isPinned: true,
			onTagClick,
			onManageTags,
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-summary"]')).toHaveLength(2);
		expect(document.querySelectorAll('.border-sidebar-badge-pinned-border')).toHaveLength(1);
		expect(screen.getAllByText('Shared row chat')).toHaveLength(2);
		expect(screen.getAllByLabelText('Unread')).toHaveLength(2);
		expect(screen.getAllByText('3h ago')).toHaveLength(2);
		expect(screen.queryByText('Jan 1')).toBeNull();
		expect(screen.queryByText('12:00 AM')).toBeNull();
		expect(screen.getAllByTitle('/very/long/workspace/projects/feature-branch/app')).toHaveLength(2);
		const sidebarPreview = screen.getAllByText('Latest preview text');
		expect(sidebarPreview).toHaveLength(2);
		expect(sidebarPreview[0]?.className).toContain('mt-0.5');
		expect(sidebarPreview[0]?.className).toContain('mb-1');
		expect(screen.getAllByText('Claude')).toHaveLength(2);
		expect(screen.getAllByText('ops')).toHaveLength(2);
		expect(screen.getAllByText('prod')).toHaveLength(2);
		expect(screen.getAllByRole('button', { name: '+1' })).toHaveLength(2);

		await fireEvent.click(screen.getAllByRole('button', { name: 'ops' })[0]!);
		expect(onTagClick).toHaveBeenCalledWith('ops');

		await fireEvent.click(screen.getAllByRole('button', { name: '+1' })[0]!);
		expect(onManageTags).toHaveBeenCalledWith('chat-1', ['ops', 'prod', 'urgent']);
	});

	it('renders the same chat summary content inside the search dialog rows', async () => {
		render(SidebarSearchDialogHarness, {
			filteredChats: [createChat({ isPinned: true })],
		});

		const option = await screen.findByRole('option');
		expect(option.className).toContain('bg-accent');
		expect(option.className).toContain('border-b');
		expect(option.className).toContain('px-3');

		expect(option.querySelector('[data-slot="sidebar-chat-summary"]')).toBeTruthy();
		expect(option.querySelector('.border-sidebar-badge-pinned-border')).toBeNull();
		expect(screen.getByText('Shared row chat')).toBeTruthy();
		expect(screen.queryByLabelText('Unread')).toBeNull();
		expect(screen.queryByText('Jan 1')).toBeNull();
		expect(screen.queryByText('12:00 AM')).toBeNull();
		expect(screen.queryByText('3h ago')).toBeNull();
		expect(screen.getByTitle('/very/long/workspace/projects/feature-branch/app')).toBeTruthy();
		expect(screen.getByText('Latest preview text').className).toContain('mt-0.5');
		expect(screen.getByText('Latest preview text').className).toContain('mb-1');
		expect(screen.getByText('Claude')).toBeTruthy();
		expect(screen.getByText('ops')).toBeTruthy();
		expect(screen.getByText('prod')).toBeTruthy();
		expect(screen.queryByRole('button', { name: '+1' })).toBeNull();
		expect(screen.getByText('+1')).toBeTruthy();
	});

	it('updates relative timestamps when currentTime changes', async () => {
		const session = createChat({
			createdAt: '2025-01-01T00:00:00.000Z',
			lastActivityAt: '2025-01-01T00:00:00.000Z',
		});

		const { rerender } = render(SidebarChatItemHarness, {
			session,
			currentTime: new Date('2025-01-01T03:00:00.000Z'),
		});

		expect(screen.getAllByText('3h ago')).toHaveLength(2);

		await rerender({
			session,
			currentTime: new Date('2025-01-01T04:00:00.000Z'),
		});

		expect(screen.getAllByText('4h ago')).toHaveLength(2);
		expect(screen.queryByText('3h ago')).toBeNull();
	});
});
