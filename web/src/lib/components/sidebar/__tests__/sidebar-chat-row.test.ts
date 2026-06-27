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

		expect(screen.getByText('Shared row chat').closest('button')?.getAttribute('draggable')).toBe(
			'true',
		);
	});

	it('omits native row dragging for Pragmatic wrappers', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			enableNativeDrag: false,
		});

		expect(screen.getByText('Shared row chat').closest('button')?.hasAttribute('draggable')).toBe(
			false,
		);
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
			'[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]',
		);
		expect(desktopMenuTrigger?.className).toContain('border-sidebar-border/70');
		expect(desktopMenuTrigger?.className).toContain('bg-background');
		for (const badge of pinnedBadges) {
			expect(badge.className).toContain('bottom-0');
			expect(badge.className).toContain('right-0');
			expect(badge.className).toContain('h-4');
			expect(badge.className).toContain('w-4');
			expect(badge.querySelector('svg')?.getAttribute('class')).toContain('size-2.5');
			expect(badge.closest('button')).not.toBe(desktopMenuTrigger);
			expect(badge.parentElement?.className).toContain('relative flex-1 min-w-0');
			expect(badge.parentElement?.className).not.toContain('pr-');
		}

		await fireEvent.click(screen.getByRole('button', { name: 'ops' }));
		expect(onTagClick).toHaveBeenCalledWith('ops');

		await fireEvent.click(screen.getByRole('button', { name: '+1' }));
		expect(onManageTags).toHaveBeenCalledWith('chat-1', ['ops', 'prod', 'urgent']);
	});

	it('sizes archived badges to the same metadata pill height', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			isArchived: true,
		});

		const archivedBadge = document.querySelector('.border-sidebar-badge-archived-border');

		expect(archivedBadge?.className).toContain('bottom-0');
		expect(archivedBadge?.className).toContain('right-0');
		expect(archivedBadge?.className).toContain('h-4');
		expect(archivedBadge?.className).toContain('w-4');
		expect(archivedBadge?.querySelector('svg')?.getAttribute('class')).toContain('size-2.5');
	});

	it('hides the last message preview row in compact mode', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			displayOptions: { groupByProject: false, compactChatItems: true },
		});

		expect(screen.getByText('Shared row chat')).toBeTruthy();
		expect(screen.queryByText('Latest preview text')).toBeNull();
		expect(screen.getByText('Claude')).toBeTruthy();
		expect(screen.getByText('ops')).toBeTruthy();
		expect(screen.getByText('prod')).toBeTruthy();
	});

	it('hides the project path in grouped chat rows while keeping timestamps', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			displayOptions: { groupByProject: true, compactChatItems: false },
		});

		expect(screen.getByText('3h ago')).toBeTruthy();
		expect(screen.queryByTitle('/very/long/workspace/projects/feature-branch/app')).toBeNull();
		expect(screen.queryByText('\u2026/projects/feature-branch/app')).toBeNull();
		expect(screen.getByText('Claude')).toBeTruthy();
	});

	it('renders the mobile chat row without also rendering the desktop row', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			isMobile: true,
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-summary"]')).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy();
		expect(
			document.querySelector('[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]'),
		).toBeNull();
	});

	it('orders sidebar-only menu actions before row actions', async () => {
		const onEnterMultiSelect = vi.fn();
		const onMoveToTop = vi.fn();
		const onMoveToBottom = vi.fn();
		render(SidebarChatItemHost, {
			session: createChat(),
			selectedChatId: 'chat-1',
			onEnterMultiSelect,
			onMoveToTop,
			onMoveToBottom,
			onManageTags: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));

		const labels = (await screen.findAllByRole('menuitem')).map((item) =>
			item.textContent?.trim(),
		);
		const menuParts = Array.from(
			document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')?.children ?? [],
		).map((item) =>
			item.getAttribute('data-slot') === 'dropdown-menu-separator'
				? 'separator'
				: item.textContent?.trim(),
		);
		expect(labels.slice(0, 3)).toEqual(['Select', 'Move to top', 'Move to bottom']);
		expect(menuParts).toEqual([
			'Select',
			'Move to top',
			'Move to bottom',
			'separator',
			'Pin',
			'Archive',
			'separator',
			'Share',
			'Details',
			'Fork',
			'Rename',
			'Manage tags',
			'separator',
			'Delete',
		]);
		expect(labels).toContain('Pin');
		expect(labels).toContain('Archive');
		expect(labels).toContain('Rename');
		expect(labels).toContain('Details');
		expect(labels).toContain('Share');
		expect(labels).toContain('Manage tags');
		expect(labels).toContain('Fork');
		expect(labels).toContain('Delete');
		const forkItem = screen.getByRole('menuitem', { name: 'Fork' });
		expect(forkItem.querySelector('.lucide-git-fork')).toBeTruthy();
		expect(forkItem.querySelector('.lucide-copy')).toBeNull();
		expect(forkItem.hasAttribute('data-disabled')).toBe(false);
		expect(screen.queryByRole('menuitem', { name: /reload from native history/i })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: /change project path/i })).toBeNull();
	});

	it('disables sidebar fork while processing when running fork is unsupported', async () => {
		const onForkChat = vi.fn();
		render(SidebarChatItemHost, {
			session: createChat({ isProcessing: true }),
			onForkChat,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));

		const forkItem = await screen.findByRole('menuitem', { name: 'Fork' });
		expect(forkItem.hasAttribute('data-disabled')).toBe(true);

		await fireEvent.click(forkItem);
		expect(onForkChat).not.toHaveBeenCalled();
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
