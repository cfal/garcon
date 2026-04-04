import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

import SavedSearchEditorDialog from '../SavedSearchEditorDialog.svelte';
import SavedSearchManagerDialog from '../SavedSearchManagerDialog.svelte';
import SidebarControlsRow from '../SidebarControlsRow.svelte';
import SidebarSearchContext from '../SidebarSearchContext.svelte';
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
		showAsSidebarPill: true,
		showInSidebarMenu: true,
		showInSearchDialog: true,
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

	it('closes from the header close button', async () => {
		const onClose = vi.fn();

		render(SidebarSearchDialogHarness, {
			filteredChats: [createChat('chat-1', 'First chat')],
			onClose,
		});

		const closeButtons = await screen.findAllByRole('button', { name: 'Close search' });
		await fireEvent.click(closeButtons[1]!);

		expect(onClose).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(screen.queryByRole('textbox')).toBeNull();
		});
	});

	it('closes when clicking outside the dialog panel', async () => {
		const onClose = vi.fn();

		render(SidebarSearchDialogHarness, {
			filteredChats: [createChat('chat-1', 'First chat')],
			onClose,
		});

		const container = document.querySelector('.fixed.inset-0.flex.items-stretch.justify-center');
		if (!(container instanceof HTMLElement)) throw new Error('Expected search dialog container');

		await fireEvent.click(container);

		expect(onClose).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(screen.queryByRole('textbox')).toBeNull();
		});
	});

	it('closes from Ctrl-S inside the dialog', async () => {
		const onClose = vi.fn();

		render(SidebarSearchDialogHarness, {
			filteredChats: [createChat('chat-1', 'First chat')],
			onClose,
		});

		const input = await screen.findByRole('textbox');
		input.focus();
		await fireEvent.keyDown(input, { key: 's', ctrlKey: true, bubbles: true });

		expect(onClose).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			expect(screen.queryByRole('textbox')).toBeNull();
		});
	});

	it('uses a command-palette shell with a fixed scrollable results pane', async () => {
		render(SidebarSearchDialogHarness, {
			filteredChats: [
				createChat('chat-1', 'First chat'),
				createChat('chat-2', 'Second chat'),
			],
		});

		const dialogContent = document.querySelector('[data-slot="search-dialog-content"]');
		expect(dialogContent?.className).toContain('sm:h-[min(44rem,calc(100dvh-8rem))]');
		expect(dialogContent?.className).toContain('sm:w-full');
		expect(dialogContent?.className).toContain('sm:max-w-3xl');
		expect(dialogContent?.className).toContain('sm:rounded-2xl');

		const input = await screen.findByRole('textbox');
		expect(input.className).toContain('bg-transparent');
		expect(input.className).toContain('outline-none');
		expect(input.className).not.toContain('pl-1');

		expect(await screen.findByRole('listbox')).toBeTruthy();
		expect(document.querySelector('[data-slot="search-dialog-results"]')?.className).toContain('flex-1');
		expect(document.querySelector('[data-slot="search-dialog-results"]')?.className).toContain('overflow-y-auto');
	});

	it('omits the saved-search pill container when there are no saved searches', async () => {
		render(SidebarSearchDialogHarness, {
			filteredChats: [createChat('chat-1', 'First chat')],
			savedSearches: [],
		});

		await screen.findByRole('textbox');
		expect(screen.queryByText('Saved searches')).toBeNull();
		expect(document.querySelector('[data-slot="saved-search-pills"]')).toBeNull();
	});

	it('keeps chat rows shrinkable within the dialog width', async () => {
		render(SidebarSearchDialogHarness, {
			filteredChats: [
				createChat(
					'chat-1',
					'Extremely long chat title that should truncate instead of pushing the row past the modal width'
				),
			],
		});

		const option = await screen.findByRole('option');
		expect(option.className).toContain('min-w-0');
		expect(option.className).toContain('bg-accent');
		expect(option.className).toContain('px-3');
		expect(option.className).not.toContain('bg-sidebar-chat-item-bg');

		const summary = option.querySelector('[data-slot="sidebar-chat-summary"]');
		if (!summary) throw new Error('Expected shared summary element');
		expect(summary.className).toContain('min-w-0');

		const title = screen.getByText(
			'Extremely long chat title that should truncate instead of pushing the row past the modal width'
		);
		expect(title.className).toContain('truncate');

		const preview = screen.getByText(
			'Extremely long chat title that should truncate instead of pushing the row past the modal width preview'
		);
		expect(preview.className).toContain('truncate');
	});

	it('renders sidebar menu searches ahead of the row actions and inserts a separator', async () => {
			render(SidebarControlsRow, {
				isLoading: false,
				isReorderMode: false,
				visibleUnreadCount: 0,
			sidebarMenuSearches: [
				createSavedSearch('search-1', 'Unread', 'status:unread'),
				createSavedSearch('search-2', 'Active', 'status:active'),
			],
			onOpenSearchDialog: vi.fn(),
			onOpenSavedSearchManager: vi.fn(),
			onCreateChat: vi.fn(),
			onApplySidebarMenuSearch: vi.fn(),
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
		expect(items[2]?.textContent).toContain('Manage searches');
		expect(items[3]?.textContent).toContain('Mark all as read');
		expect(items[4]?.textContent).toContain('Settings');
		expect(document.querySelector('[data-slot="dropdown-menu-separator"]')).toBeTruthy();
	});

	it('opens the saved-search manager from the quick search menu section', async () => {
		const onOpenSavedSearchManager = vi.fn();

		render(SidebarControlsRow, {
			isLoading: false,
			isReorderMode: false,
			visibleUnreadCount: 0,
			sidebarMenuSearches: [createSavedSearch('search-1', 'Unread', 'status:unread')],
			onOpenSearchDialog: vi.fn(),
			onOpenSavedSearchManager,
			onCreateChat: vi.fn(),
			onApplySidebarMenuSearch: vi.fn(),
			onShowSettings: vi.fn(),
		});

		const [mobileTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(mobileTrigger);
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Manage searches' }));

		expect(onOpenSavedSearchManager).toHaveBeenCalledTimes(1);
	});

	it('shows manage searches before mark all as read even without quick search entries', async () => {
		render(SidebarControlsRow, {
			isLoading: false,
			isReorderMode: false,
			visibleUnreadCount: 1,
			sidebarMenuSearches: [],
			onOpenSearchDialog: vi.fn(),
			onOpenSavedSearchManager: vi.fn(),
			onCreateChat: vi.fn(),
			onApplySidebarMenuSearch: vi.fn(),
			onShowSettings: vi.fn(),
		});

		const [mobileTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(mobileTrigger);

		const items = await screen.findAllByRole('menuitem');
		expect(items[0]?.textContent).toContain('Manage searches');
		expect(items[1]?.textContent).toContain('Mark all as read');
		expect(screen.queryByRole('separator')).toBeNull();
	});

		it('suppresses the top divider when search context sits directly below the controls row', () => {
			render(SidebarControlsRow, {
				dockPlacement: 'top',
				isLoading: false,
				isReorderMode: false,
				visibleUnreadCount: 0,
				hasSearchContextBelow: true,
				sidebarMenuSearches: [],
				onOpenSearchDialog: vi.fn(),
				onCreateChat: vi.fn(),
				onApplySidebarMenuSearch: vi.fn(),
				onShowSettings: vi.fn(),
			});

		const controlsRow = document.querySelector('[data-slot="sidebar-controls-row"]');
		expect(controlsRow?.className ?? '').not.toMatch(/\bborder-b\b/);
		expect(controlsRow?.className ?? '').toContain('px-2');
		});

	it('omits the separator when no sidebar menu searches are shown', async () => {
		render(SidebarControlsRow, {
			isLoading: false,
			isReorderMode: false,
			visibleUnreadCount: 0,
			sidebarMenuSearches: [],
			onOpenSearchDialog: vi.fn(),
			onCreateChat: vi.fn(),
			onApplySidebarMenuSearch: vi.fn(),
			onShowSettings: vi.fn(),
		});

		const [mobileTrigger] = screen.getAllByRole('button', { name: 'More actions' });
		await fireEvent.click(mobileTrigger);

		await waitFor(() => {
			expect(screen.getByRole('menu')).toBeTruthy();
		});

		expect(screen.queryByRole('separator')).toBeNull();
	});

	it('renders sidebar pill searches and clears the active search banner', async () => {
		const onApplyPillSearch = vi.fn();
		const onClearActiveQuery = vi.fn();

		render(SidebarSearchContext, {
			sidebarPillSearches: [createSavedSearch('search-1', 'Unread', 'status:unread')],
			activeQuery: 'tag:ops',
			onApplyPillSearch,
			onClearActiveQuery,
		});

		expect(screen.getByRole('button', { name: 'Unread' })).toBeTruthy();
		expect(document.querySelector('[data-slot="active-search-banner"]')?.textContent).toContain('tag:ops');

		await fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
		expect(onApplyPillSearch).toHaveBeenCalledTimes(1);

		await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(onClearActiveQuery).toHaveBeenCalledTimes(1);
	});

	it('tightens the top seam only when the controls row is above the search context', () => {
		const { rerender } = render(SidebarSearchContext, {
			sidebarPillSearches: [createSavedSearch('search-1', 'Unread', 'status:unread')],
			activeQuery: '',
			hasControlsRowAbove: true,
			onApplyPillSearch: vi.fn(),
			onClearActiveQuery: vi.fn(),
		});

		const compactContext = document.querySelector('[data-slot="sidebar-search-pills"]')?.parentElement;
		expect(compactContext?.className).toContain('px-2');
		expect(compactContext?.className).toContain('pb-2');
		expect(compactContext?.className).not.toContain('pt-');
		expect(compactContext?.className).not.toContain('py-2');

		rerender({
			sidebarPillSearches: [createSavedSearch('search-1', 'Unread', 'status:unread')],
			activeQuery: '',
			hasControlsRowAbove: false,
			onApplyPillSearch: vi.fn(),
			onClearActiveQuery: vi.fn(),
		});

		const defaultContext = document.querySelector('[data-slot="sidebar-search-pills"]')?.parentElement;
		expect(defaultContext?.className).toContain('px-2');
		expect(defaultContext?.className).toContain('py-2');
	});

	it('omits sidebar search context when there are no pills and no active query', () => {
		render(SidebarSearchContext, {
			sidebarPillSearches: [],
			activeQuery: '',
			onApplyPillSearch: vi.fn(),
			onClearActiveQuery: vi.fn(),
		});

		expect(document.querySelector('[data-slot="sidebar-search-pills"]')).toBeNull();
		expect(document.querySelector('[data-slot="active-search-banner"]')).toBeNull();
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

	it('requires at least one saved-search visibility target in the editor', async () => {
		render(SavedSearchEditorDialog, {
			editorState: {
				mode: 'create',
				title: '',
				query: 'status:active',
				showAsSidebarPill: false,
				showInSidebarMenu: false,
				showInSearchDialog: false,
			},
			onClose: vi.fn(),
			onSave: vi.fn(async () => undefined),
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('At least one visibility option is required')).toBeTruthy();
	});
});
