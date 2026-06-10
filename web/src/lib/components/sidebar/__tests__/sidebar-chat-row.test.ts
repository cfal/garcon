import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SidebarChatItemHost from './SidebarChatItemHost.svelte';
import SidebarSearchDialogHost from './SidebarSearchDialogHost.svelte';

import type { ChatSessionRecord } from '$lib/types/chat-session';

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/very/long/workspace/projects/feature-branch/app',
		title: 'Shared row chat',
		agentId: 'claude',
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
	it('keeps standalone desktop rows natively draggable by default', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
		});

		expect(screen.getByText('Shared row chat').closest('button')?.getAttribute('draggable')).toBe('true');
	});

	it('omits native row dragging for Pragmatic wrappers', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			enableNativeDrag: false,
		});

		expect(screen.getByText('Shared row chat').closest('button')?.hasAttribute('draggable')).toBe(false);
	});

	it('renders the shared chat summary inside the sidebar item shell', async () => {
		const onTagClick = vi.fn();
		const onManageTags = vi.fn();

		render(SidebarChatItemHost, {
			session: createChat(),
			isPinned: true,
			onTagClick,
			onManageTags,
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-summary"]')).toHaveLength(1);
		const pinnedBadges = document.querySelectorAll('.border-sidebar-badge-pinned-border');
		expect(pinnedBadges).toHaveLength(1);
		expect(screen.getByText('Shared row chat')).toBeTruthy();
		expect(screen.getByLabelText('Unread')).toBeTruthy();
		expect(screen.getByText('3h ago')).toBeTruthy();
		expect(screen.getByText('3h ago').className).toContain('font-normal');
		expect(screen.getByText('3h ago').className).not.toContain('md:group-hover:opacity-0');
		expect(screen.queryByText('Jan 1')).toBeNull();
		expect(screen.queryByText('12:00 AM')).toBeNull();
		expect(screen.getByTitle('/very/long/workspace/projects/feature-branch/app')).toBeTruthy();
		const metadataProjectLabel = screen.getByText('\u2026/projects/feature-branch/app');
		expect(metadataProjectLabel.className).toContain('font-semibold');
		expect(metadataProjectLabel.parentElement?.className).toContain('text-[12px]');
		expect(metadataProjectLabel.parentElement?.className).toContain('gap-1');
		const sidebarPreview = screen.getByText('Latest preview text');
		expect(sidebarPreview.className).toContain('mt-0.5');
		expect(sidebarPreview.className).toContain('mb-1');
		expect(screen.getByText('Claude')).toBeTruthy();
		expect(screen.getByText('ops')).toBeTruthy();
		expect(screen.getByText('prod')).toBeTruthy();
		expect(screen.getByRole('button', { name: '+1' })).toBeTruthy();
		const desktopMenuTrigger = document.querySelector<HTMLElement>(
			'[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]'
		);
		expect(desktopMenuTrigger?.className).toContain('border-sidebar-border/70');
		expect(desktopMenuTrigger?.className).toContain('bg-background');
		for (const badge of pinnedBadges) {
			expect(badge.className).toContain('bottom-0');
			expect(badge.className).toContain('right-0');
			expect(badge.closest('button')).not.toBe(desktopMenuTrigger);
			expect(badge.parentElement?.className).toContain('relative flex-1 min-w-0');
			expect(badge.parentElement?.className).not.toContain('pr-');
		}

		await fireEvent.click(screen.getByRole('button', { name: 'ops' }));
		expect(onTagClick).toHaveBeenCalledWith('ops');

		await fireEvent.click(screen.getByRole('button', { name: '+1' }));
		expect(onManageTags).toHaveBeenCalledWith('chat-1', ['ops', 'prod', 'urgent']);
	});

	it('renders the mobile chat row without also rendering the desktop row', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			isMobile: true,
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-summary"]')).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy();
		expect(document.querySelector('[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]')).toBeNull();
	});

	it('renders the same chat summary content inside the search dialog rows', async () => {
		render(SidebarSearchDialogHost, {
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
		expect(screen.getByText('3h ago')).toBeTruthy();
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

		const { rerender } = render(SidebarChatItemHost, {
			session,
			currentTime: new Date('2025-01-01T03:00:00.000Z'),
		});

		expect(screen.getByText('3h ago')).toBeTruthy();

		await rerender({
			session,
			currentTime: new Date('2025-01-01T04:00:00.000Z'),
		});

		expect(screen.getByText('4h ago')).toBeTruthy();
		expect(screen.queryByText('3h ago')).toBeNull();
	});
});
