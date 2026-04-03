import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SavedSearchManagerDialog from '../SavedSearchManagerDialog.svelte';
import SidebarFooter from '../SidebarFooter.svelte';
import SidebarSearchDialogHarness from './SidebarSearchDialogHarness.svelte';

import type { SavedChatSearch } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function createChat(id: string, title: string): ChatSessionRecord {
	return {
		id,
		projectPath: '/tmp/project',
		title,
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
		isUnread: false,
		status: 'draft',
		lastMessage: `${title} preview`,
		tags: [],
		firstMessage: `${title} first`,
	};
}

function createSavedSearch(id: string, title: string, query: string): SavedChatSearch {
	return {
		id,
		title,
		query,
		showInQuickMenu: true,
		createdAt: '2025-01-01T00:00:00.000Z',
		updatedAt: '2025-01-01T00:00:00.000Z',
	};
}

describe('sidebar search interactions', () => {
	it('opens the highlighted chat from the query input and respects Ctrl-J selection', async () => {
		const onSelectChat = vi.fn();

		render(SidebarSearchDialogHarness, {
			filteredChats: [
				createChat('chat-1', 'First chat'),
				createChat('chat-2', 'Second chat'),
			],
			onSelectChat,
		});

		const input = await screen.findByRole('textbox');
		input.focus();

		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(onSelectChat).toHaveBeenNthCalledWith(1, 'chat-1');

		await fireEvent.keyDown(input, { key: 'j', ctrlKey: true });
		await fireEvent.keyDown(input, { key: 'Enter' });
		expect(onSelectChat).toHaveBeenNthCalledWith(2, 'chat-2');
	});

	it('does not let Enter on the edit button or saved-search pills open a chat', async () => {
		const onSelectChat = vi.fn();
		const onOpenManager = vi.fn();
		const onApplySavedSearch = vi.fn();

		render(SidebarSearchDialogHarness, {
			filteredChats: [createChat('chat-1', 'First chat')],
			savedSearches: [createSavedSearch('search-1', 'Unread', 'status:unread')],
			onSelectChat,
			onOpenManager,
			onApplySavedSearch,
		});

		const editButton = await screen.findByRole('button', { name: 'Edit' });
		editButton.focus();
		await fireEvent.keyDown(editButton, { key: 'Enter' });

		const pillButton = screen.getByRole('button', { name: 'Unread' });
		pillButton.focus();
		await fireEvent.keyDown(pillButton, { key: 'Enter' });

		expect(onSelectChat).not.toHaveBeenCalled();
		expect(onOpenManager).not.toHaveBeenCalled();
		expect(onApplySavedSearch).not.toHaveBeenCalled();
	});

	it('renders quick searches ahead of the footer actions and inserts a separator', async () => {
		render(SidebarFooter, {
			isLoading: false,
			searchFilter: '',
			isReorderMode: false,
			visibleUnreadCount: 0,
			quickMenuSearches: [
				createSavedSearch('search-1', 'Unread', 'status:unread'),
				createSavedSearch('search-2', 'Active', 'status:active'),
			],
			onOpenSearchDialog: vi.fn(),
			onClearSearchFilter: vi.fn(),
			onCreateChat: vi.fn(),
			onApplyQuickSearch: vi.fn(),
			onShowSettings: vi.fn(),
		});

		const [mobileTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(mobileTrigger);

		await waitFor(() => {
			expect(screen.getByRole('menu')).toBeTruthy();
		});

		const items = screen.getAllByRole('menuitem');
		expect(items[0]?.textContent).toContain('Unread');
		expect(items[1]?.textContent).toContain('Active');
		expect(items[2]?.textContent).toContain('Mark all as read');
		expect(items[3]?.textContent).toContain('Settings');
		expect(document.querySelector('[data-slot="dropdown-menu-separator"]')).toBeTruthy();
	});

	it('omits the separator when no quick searches are shown', async () => {
		render(SidebarFooter, {
			isLoading: false,
			searchFilter: '',
			isReorderMode: false,
			visibleUnreadCount: 0,
			quickMenuSearches: [],
			onOpenSearchDialog: vi.fn(),
			onClearSearchFilter: vi.fn(),
			onCreateChat: vi.fn(),
			onApplyQuickSearch: vi.fn(),
			onShowSettings: vi.fn(),
		});

		const [mobileTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(mobileTrigger);

		await waitFor(() => {
			expect(screen.getByRole('menu')).toBeTruthy();
		});

		expect(screen.queryByRole('separator')).toBeNull();
	});

	it('supports button-based reordering for saved searches', async () => {
		const onReorder = vi.fn();

		render(SavedSearchManagerDialog, {
			open: true,
			searches: [
				createSavedSearch('search-1', 'Unread', 'status:unread'),
				createSavedSearch('search-2', 'Active', 'status:active'),
				createSavedSearch('search-3', 'Tagged', 'tag:ops'),
			],
			onClose: vi.fn(),
			onAdd: vi.fn(),
			onEdit: vi.fn(),
			onDelete: vi.fn(),
			onReorder,
		});

		const moveDownButton = await screen.findByRole('button', { name: 'Move Unread down' });
		await fireEvent.click(moveDownButton);

		expect(onReorder).toHaveBeenCalledWith(
			['search-1', 'search-2', 'search-3'],
			['search-2', 'search-1', 'search-3'],
		);
		expect((screen.getByRole('button', { name: 'Move Unread up' }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole('button', { name: 'Move Tagged down' }) as HTMLButtonElement).disabled).toBe(true);
	});
});
