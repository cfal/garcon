import { fireEvent, render, screen } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import SidebarChatItemHost from './SidebarChatItemHost.svelte';
import SidebarSearchDialogHost from './SidebarSearchDialogHost.svelte';

import type { ChatSessionRecord } from '$lib/types/chat-session';

const appCss = readFileSync('src/app.css', 'utf8');

function createChat(overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/very/long/workspace/projects/feature-branch/app',
		effectiveProjectKey: '/very/long/workspace/projects/feature-branch/app',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Shared row chat',
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
		isUnread: true,
		canReloadFromNativeHistory: false,
		status: 'draft',
		lastMessage: 'Latest preview text',
		tags: ['ops', 'prod', 'urgent'],
		firstMessage: 'First message',
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
	};
}

describe('shared sidebar chat row', () => {
	it.each([false, true])('exposes the current chat on %s mobile rows', (isMobile) => {
		render(SidebarChatItemHost, {
			session: createChat(),
			selectedChatId: 'chat-1',
			isMobile,
		});

		expect(screen.getByText('Shared row chat').closest('button')?.getAttribute('aria-current')).toBe(
			'page',
		);
	});

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
			displayOptions: { chatItemLayout: 'default' },
			onTagClick,
			onManageTags,
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-summary"]')).toHaveLength(1);
		const pinnedBadges = document.querySelectorAll('.border-sidebar-badge-pinned-border');
		expect(pinnedBadges).toHaveLength(1);
		expect(screen.getByText('Pinned').className).toContain('sr-only');
		const title = screen.getByText('Shared row chat');
		expect(title.className).toContain('font-bold');
		const unreadStatus = screen.getByText('Unread');
		expect(unreadStatus.className).toContain('sr-only');
		expect(unreadStatus.getAttribute('data-slot')).toBe('sidebar-chat-unread-status');
		expect(document.querySelector('.bg-indicator-unread')).toBeNull();
		expect(document.querySelector('[data-slot="sidebar-chat-processing-indicator"]')).toBeNull();
		expect(screen.getByText('3h ago')).toBeTruthy();
		expect(title.parentElement?.className).toContain('leading-[1.3]');
		expect(screen.getByText('3h ago').className).toContain('font-normal');
		expect(screen.getByText('3h ago').className).not.toContain('ml-auto');
		expect(screen.getByText('3h ago').className).not.toContain('group-hover:opacity-0');
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
		expect(sidebarPreview.className).toContain('font-semibold');
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
			expect(badge.parentElement?.className).not.toContain('pr-8');
		}

		await fireEvent.click(screen.getByRole('button', { name: 'ops' }));
		expect(onTagClick).toHaveBeenCalledWith('ops');

		await fireEvent.click(screen.getByRole('button', { name: '+1' }));
		expect(onManageTags).toHaveBeenCalledWith(expect.objectContaining({ id: 'chat-1' }));
	});

	it('uses independent unread emphasis and activity treatments', async () => {
		const { rerender } = render(SidebarChatItemHost, {
			session: createChat({ isUnread: true, isProcessing: true }),
			displayOptions: { chatItemLayout: 'default' },
		});

		const title = screen.getByText('Shared row chat');
		const processingIndicator = document.querySelector(
			'[data-slot="sidebar-chat-processing-indicator"]',
		);
		const preview = screen.getByText('Latest preview text');
		expect(title.className).toContain('font-bold');
		expect(preview.className).toContain('font-semibold');
		expect(title.className).not.toContain('flex-1');
		expect(title.parentElement?.className).toContain('gap-1.5');
		expect(screen.getByText('Unread').className).toContain('sr-only');
		expect(screen.getByText('Chat is processing').className).toContain('sr-only');
		expect(processingIndicator?.className).toContain('shrink-0');
		expect(processingIndicator?.parentElement).toBe(title.parentElement);
		expect(document.querySelector('[data-slot="sidebar-chat-processing-slot"]')).toBeNull();
		expect(title.closest('button')?.className).not.toContain('border-l-status-processing');

		await rerender({
			session: createChat({ isUnread: false, isProcessing: true }),
		});

		expect(title.className).toContain('font-medium');
		expect(title.className).not.toContain('font-bold');
		expect(preview.className).toContain('font-normal');
		expect(preview.className).not.toContain('font-semibold');
		expect(screen.queryByText('Unread')).toBeNull();
		expect(document.querySelector('[data-slot="sidebar-chat-processing-indicator"]')).toBeTruthy();

		await rerender({
			session: createChat({ isUnread: true, isProcessing: true }),
			selectedChatId: 'chat-1',
		});

		expect(title.className).toContain('font-medium');
		expect(title.className).not.toContain('font-bold');
		expect(preview.className).toContain('font-normal');
		expect(preview.className).not.toContain('font-semibold');
		expect(screen.queryByText('Unread')).toBeNull();
		expect(document.querySelector('[data-slot="sidebar-chat-processing-indicator"]')).toBeTruthy();

		await rerender({
			session: createChat({ isUnread: false, isProcessing: false }),
			selectedChatId: null,
		});

		expect(screen.queryByText('Chat is processing')).toBeNull();
		expect(document.querySelector('[data-slot="sidebar-chat-processing-indicator"]')).toBeNull();
		expect(document.querySelector('[data-slot="sidebar-chat-processing-slot"]')).toBeNull();
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
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'compact',
				sortMode: 'manual',
			},
		});

		expect(screen.getByText('Shared row chat')).toBeTruthy();
		expect(screen.queryByText('Latest preview text')).toBeNull();
		expect(screen.getByText('Claude')).toBeTruthy();
		expect(screen.getByText('ops')).toBeTruthy();
		expect(screen.getByText('prod')).toBeTruthy();
	});

	it('renders single-line rows with an inline timestamp badge and no metadata rows', () => {
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false }),
			isPinned: true,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		const title = screen.getByText('Shared row chat');
		expect(title.className).toContain('truncate');
		expect(title.className).not.toContain('flex-1');
		expect(screen.queryByText('Latest preview text')).toBeNull();
		expect(screen.queryByText('Claude')).toBeNull();
		expect(screen.queryByText('ops')).toBeNull();
		expect(screen.queryByTitle('/very/long/workspace/projects/feature-branch/app')).toBeNull();
		expect(document.querySelector('[data-slot="sidebar-chat-processing-indicator"]')).toBeNull();

		const timestampBadge = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-timestamp-badge"]',
		);
		expect(timestampBadge?.textContent).toBe('3h ago');
		expect(timestampBadge?.className).toContain('tabular-nums');
		expect(timestampBadge?.className).toContain('ml-auto');
		expect(timestampBadge?.className).toContain('group-hover:opacity-0');
		expect(timestampBadge?.className).toContain('group-focus-within:opacity-0');
		expect(timestampBadge?.className).toContain('mr-6');
		expect(timestampBadge?.className).toContain('[@media(hover:hover)_and_(pointer:fine)]:mr-0');
		expect(timestampBadge?.getAttribute('title')).toBeTruthy();

		const stateBadge = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-state-badge"]',
		);
		expect(stateBadge?.className).toContain('relative');
		expect(stateBadge?.className).not.toContain('bottom-0');
		expect(stateBadge?.getAttribute('aria-hidden')).toBeNull();
		expect(screen.getByText('Pinned').className).toContain('sr-only');
		if (!stateBadge || !timestampBadge) throw new Error('expected badges');
		expect(title.compareDocumentPosition(stateBadge)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(stateBadge.compareDocumentPosition(timestampBadge)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		expect(stateBadge.parentElement).toBe(title.parentElement);
		expect(timestampBadge.parentElement).toBe(title.parentElement);
		expect(
			document.querySelector<HTMLElement>('[data-slot="sidebar-chat-summary"]')?.className,
		).toContain('w-full');

		// The row button keeps the default-mode overlay anchor placement without
		// reserving a right gutter, with reduced vertical padding.
		const rowButton = title.closest('button');
		expect(rowButton?.className).not.toContain('pr-9');
		expect(rowButton?.className).toContain('py-[2px]');
		const menuAnchor = document.querySelector<HTMLElement>('.sidebar-item-menu-anchor');
		expect(menuAnchor?.className).toContain('top-1/2');
		expect(menuAnchor?.className).toContain('-translate-y-1/2');
	});

	it('does not reserve title space for an absent single-line state badge', () => {
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false }),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		const title = screen.getByText('Shared row chat');
		const timestampBadge = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-timestamp-badge"]',
		);
		expect(document.querySelector('[data-slot="sidebar-chat-state-badge"]')).toBeNull();
		const titleRowChildren = Array.from(title.parentElement?.children ?? []);
		expect(titleRowChildren).toHaveLength(2);
		expect(titleRowChildren[0]).toBe(title);
		expect(titleRowChildren[1]).toBe(timestampBadge);
	});

	it('shows the processing indicator instead of the timestamp badge in single-line mode', () => {
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false, isProcessing: true }),
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		const processingIndicator = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-processing-indicator"]',
		);
		expect(processingIndicator).toBeTruthy();
		expect(document.querySelector('[data-slot="sidebar-chat-timestamp-badge"]')).toBeNull();
		expect(processingIndicator?.parentElement?.className).toContain('ml-auto');
		expect(processingIndicator?.parentElement?.className).toContain('pr-0.5');
		expect(processingIndicator?.parentElement?.className).toContain('group-hover:opacity-0');
		expect(processingIndicator?.parentElement?.className).toContain('group-focus-within:opacity-0');
		const processingLabel = screen.getByText('Chat is processing');
		expect(processingLabel.className).toContain('sr-only');
		expect(processingIndicator?.contains(processingLabel)).toBe(false);
	});

	it('prefers the pinned badge over the archived badge in single-line mode', () => {
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false }),
			isPinned: true,
			isArchived: true,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-state-badge"]')).toHaveLength(1);
		expect(screen.getByText('Pinned')).toBeTruthy();
		expect(screen.queryByText('Archived')).toBeNull();
	});

	it('renders the single-line mobile row once with the inline badge', () => {
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false }),
			isPinned: true,
			isMobile: true,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		expect(document.querySelectorAll('[data-slot="sidebar-chat-summary"]')).toHaveLength(1);
		const timestampBadge = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-timestamp-badge"]',
		);
		const stateBadge = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-state-badge"]',
		);
		expect(timestampBadge?.className).toContain('ml-auto');
		expect(timestampBadge?.className).not.toContain('group-hover:opacity-0');
		expect(timestampBadge?.className).not.toContain('mr-6');
		expect(stateBadge).toBeTruthy();
		expect(stateBadge?.parentElement).toBe(screen.getByText('Shared row chat').parentElement);
		expect(screen.getByRole('button', { name: 'Chat actions' })).toBeTruthy();
	});

	it('keeps the single-line status visible without a menu in desktop multi-select mode', () => {
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false }),
			isMultiSelectMode: true,
			displayOptions: {
				grouping: 'none',
				groupNestedProjectPaths: false,
				chatItemLayout: 'single-line',
				sortMode: 'manual',
			},
		});

		const timestampBadge = document.querySelector<HTMLElement>(
			'[data-slot="sidebar-chat-timestamp-badge"]',
		);
		expect(timestampBadge?.className).toContain('ml-auto');
		expect(timestampBadge?.className).not.toContain('mr-6');
		expect(timestampBadge?.className).not.toContain('group-hover:opacity-0');
		expect(screen.queryByRole('button', { name: 'Chat actions' })).toBeNull();
	});

	it('exposes the multi-select row as a keyboard-reachable checkbox', async () => {
		const onMultiSelectToggle = vi.fn();
		render(SidebarChatItemHost, {
			session: createChat({ isUnread: false }),
			isMultiSelectMode: true,
			isMultiSelected: true,
			onMultiSelectToggle,
		});

		const checkbox = screen.getByRole('checkbox', { name: 'Select Shared row chat' });
		expect(checkbox.tagName).toBe('BUTTON');
		expect(checkbox.tabIndex).toBe(0);
		expect(checkbox.getAttribute('aria-checked')).toBe('true');
		expect(checkbox.hasAttribute('aria-current')).toBe(false);
		expect(checkbox.querySelector('[role="checkbox"]')).toBeNull();

		await fireEvent.click(checkbox, { shiftKey: true });
		expect(onMultiSelectToggle).toHaveBeenCalledWith('chat-1', true);
	});

	it('hides the project path in grouped chat rows while keeping timestamps', () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			displayOptions: {
				grouping: 'project',
				groupNestedProjectPaths: false,
				chatItemLayout: 'default',
				sortMode: 'manual',
			},
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
			document.querySelector('[data-slot="sidebar-chat-summary"]')?.parentElement?.className,
		).not.toContain('pr-8');
		expect(
			document.querySelector('[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]'),
		).toBeNull();
	});

	it('orders sidebar-only menu actions before row actions', async () => {
		const onEnterMultiSelect = vi.fn();
		const onMoveToTop = vi.fn();
		const onMoveToBottom = vi.fn();
		const onSortChatOrder = vi.fn();
		render(SidebarChatItemHost, {
			session: createChat(),
			selectedChatId: 'chat-1',
			onEnterMultiSelect,
			onMoveToTop,
			onMoveToBottom,
			onSortChatOrder,
			onManageTags: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));

		const labels = (await screen.findAllByRole('menuitem')).map((item) => item.textContent?.trim());
		const menuParts = Array.from(
			document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]')?.children ?? [],
		).map((item) =>
			item.getAttribute('data-slot') === 'dropdown-menu-separator'
				? 'separator'
				: item.textContent?.trim(),
		);
		expect(labels.slice(0, 4)).toEqual([
			'Select',
			'Move to top',
			'Move to bottom',
			'Reorder chats',
		]);
		expect(menuParts).toEqual([
			'Select',
			'Move to top',
			'Move to bottom',
			'Reorder chats',
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

	it.each([
		['By creation time', 'created'],
		['By recent activity', 'activity'],
	] as const)('reorders chats with %s from the keyboard submenu', async (label, sortKey) => {
		const onSortChatOrder = vi.fn();
		render(SidebarChatItemHost, {
			session: createChat(),
			onSortChatOrder,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
		const reorderSubmenu = screen.getByRole('menuitem', { name: 'Reorder chats' });
		reorderSubmenu.focus();
		await fireEvent.keyDown(reorderSubmenu, { key: 'ArrowRight' });
		await fireEvent.click(await screen.findByRole('menuitem', { name: label }));

		expect(onSortChatOrder).toHaveBeenCalledWith(sortKey);
	});

	it('shows the reorder submenu without quick-move actions', async () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			onSortChatOrder: vi.fn(),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));

		expect(screen.getByRole('menuitem', { name: 'Reorder chats' })).toBeTruthy();
		expect(screen.queryByRole('menuitem', { name: 'Move to top' })).toBeNull();
		expect(screen.queryByRole('menuitem', { name: 'Move to bottom' })).toBeNull();
	});

	it('opens a sidebar chat at an edge from the single new-window submenu', async () => {
		const onOpenInNewWindow = vi.fn();
		render(SidebarChatItemHost, {
			session: createChat(),
			onOpenInNewWindow,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
		const openSubmenu = screen.getByRole('menuitem', { name: 'Open in new window' });
		openSubmenu.focus();
		await fireEvent.keyDown(openSubmenu, { key: 'ArrowRight' });
		await fireEvent.click(
			await screen.findByRole('menuitem', { name: 'Open new window right' }),
		);

		expect(onOpenInNewWindow).toHaveBeenCalledWith('chat-1', 'right');
		expect(screen.queryByRole('menuitem', { name: 'Open in new window at edge' })).toBeNull();
	});

	it('disables sidebar Chat window placement at the window cap', async () => {
		render(SidebarChatItemHost, {
			session: createChat(),
			onOpenInNewWindow: vi.fn(),
			newWindowBlocked: true,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Chat actions' }));
		const openItem = screen.getByRole('menuitem', { name: 'Open in new window' });
		expect(openItem.getAttribute('aria-disabled')).toBe('true');
		expect(openItem.getAttribute('title')).toBe('4 windows max');
		expect(screen.queryByRole('menuitem', { name: 'Open in new window at edge' })).toBeNull();
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
			filteredChats: [createChat({ isPinned: true, isProcessing: true })],
			reduceMotion: true,
		});

		const option = await screen.findByRole('option');
		expect(option.className).toContain('bg-accent');
		expect(option.className).toContain('px-3');
		expect(option.className).not.toContain('border-l-status-processing');
		expect(option.parentElement?.className).toContain('divide-y');

		expect(option.querySelector('[data-slot="sidebar-chat-summary"]')).toBeTruthy();
		expect(option.querySelector('.border-sidebar-badge-pinned-border')).toBeNull();
		expect(screen.getByText('Shared row chat')).toBeTruthy();
		expect(screen.getByText('Unread').className).toContain('sr-only');
		expect(screen.getByText('Chat is processing').className).toContain('sr-only');
		const processingIndicator = option.querySelector(
			'[data-slot="sidebar-chat-processing-indicator"]',
		);
		expect(processingIndicator).toBeTruthy();
		expect(processingIndicator?.closest('.sidebar-reduce-motion')).toBeTruthy();
		const searchTitle = screen.getByText('Shared row chat');
		expect(searchTitle.className).toContain('font-bold');
		expect(processingIndicator?.parentElement).toBe(searchTitle.parentElement);
		expect(screen.queryByText('Jan 1')).toBeNull();
		expect(screen.queryByText('12:00 AM')).toBeNull();
		expect(screen.getByText('3h ago')).toBeTruthy();
		expect(screen.getByTitle('/very/long/workspace/projects/feature-branch/app')).toBeTruthy();
		const searchPreview = screen.getByText('Latest preview text');
		expect(searchPreview.className).toContain('mt-0.5');
		expect(searchPreview.className).toContain('mb-1');
		expect(searchPreview.className).toContain('font-semibold');
		expect(screen.getByText('Claude')).toBeTruthy();
		expect(screen.getByText('ops')).toBeTruthy();
		expect(screen.getByText('prod')).toBeTruthy();
		expect(screen.queryByRole('button', { name: '+1' })).toBeNull();
		expect(screen.getByText('+1')).toBeTruthy();
	});

	it('pulses processing only when system and local motion preferences allow it', () => {
		expect(appCss).toContain('@keyframes sidebar-processing-pulse');
		expect(appCss).toMatch(
			/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\.sidebar-processing-indicator,\s*\.workspace-chat-processing-indicator\s*\{[\s\S]*?animation: sidebar-processing-pulse 1\.6s ease-in-out infinite;[\s\S]*?\}/,
		);
		expect(appCss).toMatch(
			/\.sidebar-reduce-motion \.sidebar-processing-indicator\s*\{\s*animation: none;\s*\}/,
		);
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
