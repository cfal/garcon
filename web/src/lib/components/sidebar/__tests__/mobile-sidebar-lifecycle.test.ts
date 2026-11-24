import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileSidebarLifecycleHost from './MobileSidebarLifecycleHost.svelte';
import { chat, delegated } from '$lib/sidebar/display/__tests__/sidebar-fixtures';

import { getSavedSearches, type SavedChatSearch } from '$lib/api/settings';
import { createSidebarSearchStore } from '$lib/sidebar/search/sidebar-search-store.svelte.js';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';

vi.mock('$lib/api/settings', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/settings')>('$lib/api/settings');
	return {
		...actual,
		getSavedSearches: vi.fn(),
	};
});

function createChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/tmp/project',
		orderGroup: 'normal',
		title: 'Chat',
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
		activityStatus: null,
		canReloadFromNativeHistory: false,
		status: 'draft',
		lastMessage: 'Preview',
		tags: [],
		firstMessage: 'First',
		...overrides,
		parentChatId: overrides.parentChatId ?? null,
		lineage: overrides.lineage ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
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
		createdAt: '2026-03-27T00:00:00.000Z',
		updatedAt: '2026-03-27T00:00:00.000Z',
	};
}

describe('mobile sidebar lifecycle', () => {
	it('retains display nesting across drawer remounts without combining project paths', async () => {
		render(MobileSidebarLifecycleHost, {
			chats: [
				delegated('child', 'parent'),
				chat('parent'),
				chat('nested-project', { projectPath: '/workspace/app/packages/api' }),
			],
			autoLoadSavedSearches: false,
		});
		await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Sidebar display' }));
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Nest delegated chats' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
		const assertNested = () => {
			const ids = Array.from(document.querySelectorAll('[data-sidebar-virtual-row]'), (row) =>
				row.getAttribute('data-sidebar-virtual-row'),
			);
			expect(ids.indexOf('child')).toBe(ids.indexOf('parent') + 1);
			expect(document.querySelector('[data-sidebar-virtual-row-content] > button')).toBeNull();
			expect(
				document.querySelector('[data-sidebar-project-header="/workspace/app/packages/api"]'),
			).toBeTruthy();
		};
		await waitFor(assertNested);
		await fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
		assertNested();
		await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Sidebar display' }));
		expect(screen.getByRole('checkbox', { name: 'Nest delegated chats' })).toHaveProperty(
			'checked',
			true,
		);
	});

	it('retains an in-flight relative move across drawer remounts', async () => {
		let release!: () => void;
		const writeOrder = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		render(MobileSidebarLifecycleHost, {
			chats: [
				createChat({ id: 'first', title: 'First' }),
				createChat({ id: 'second', title: 'Second' }),
			],
			autoLoadSavedSearches: false,
			writeOrder,
		});
		const order = () =>
			Array.from(document.querySelectorAll('[data-sidebar-virtual-row]'), (row) =>
				row.getAttribute('data-sidebar-virtual-row'),
			);
		const first = within(
			document.querySelector('[data-sidebar-virtual-row="first"]') as HTMLElement,
		);
		await fireEvent.click(first.getByRole('button', { name: 'Chat actions' }));
		await fireEvent.click(await screen.findByRole('menuitem', { name: 'Last in this group' }));
		await waitFor(() => expect(writeOrder).toHaveBeenCalledOnce());
		expect(order()).toEqual(['second', 'first']);
		await fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
		expect(order()).toEqual(['second', 'first']);
		expect(writeOrder).toHaveBeenCalledOnce();
		release();
	});
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getSavedSearches).mockResolvedValue({
			savedSearches: [createSavedSearch('unread', 'Unread', 'status:unread')],
		});
	});

	afterEach(() => {
		cleanup();
	});

	it('preserves the active saved-search pill across drawer close and reopen', async () => {
		render(MobileSidebarLifecycleHost, {
			chats: [
				createChat({ id: 'unread-chat', title: 'Unread chat', isUnread: true }),
				createChat({ id: 'read-chat', title: 'Read chat', isUnread: false }),
			],
		});

		const pill = await screen.findByRole('button', { name: 'Unread' });
		await fireEvent.click(pill);

		expect(screen.getByRole('button', { name: 'Unread' }).getAttribute('aria-pressed')).toBe(
			'true',
		);
		expect(screen.getByText('Unread chat')).toBeTruthy();
		expect(screen.queryByText('Read chat')).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		expect(screen.queryByRole('button', { name: 'Unread' })).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

		const reopenedPill = await screen.findByRole('button', { name: 'Unread' });
		expect(reopenedPill.getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByText('Unread chat')).toBeTruthy();
		expect(screen.queryByText('Read chat')).toBeNull();
		expect(getSavedSearches).toHaveBeenCalledTimes(1);
	});

	it('renders preloaded saved-search pills immediately when the drawer opens', async () => {
		const injectedGetSavedSearches = vi.fn().mockResolvedValue({ savedSearches: [] });
		const chats = [createChat({ id: 'unread-chat', title: 'Unread chat', isUnread: true })];
		const sidebarSearch = createSidebarSearchStore({
			getTranscriptSearchEnabled: () => true,
			getSearchResultSort: () => 'relevance',
			getChats: () => chats,
			getSelectedChatId: () => null,
			notifyError: vi.fn(),
			getSavedSearches: injectedGetSavedSearches,
		});
		sidebarSearch.setSavedSearches([createSavedSearch('unread', 'Unread', 'status:unread')]);

		render(MobileSidebarLifecycleHost, {
			chats,
			sidebarSearch,
			initialOpen: false,
		});

		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

		expect(screen.getByRole('button', { name: 'Unread' })).toBeTruthy();
		await waitFor(() => {
			expect(injectedGetSavedSearches).not.toHaveBeenCalled();
		});
	});

	it('closes an open search dialog when the drawer closes and does not reopen it', async () => {
		const chats = [createChat({ id: 'chat-1', title: 'Chat one' })];
		const sidebarSearch = createSidebarSearchStore({
			getTranscriptSearchEnabled: () => false,
			getSearchResultSort: () => 'relevance',
			getChats: () => chats,
			getSelectedChatId: () => null,
			notifyError: vi.fn(),
			getSavedSearches: vi.fn().mockResolvedValue({ savedSearches: [] }),
		});
		render(MobileSidebarLifecycleHost, { chats, sidebarSearch });

		await fireEvent.click(screen.getByRole('button', { name: 'Search chats...' }));
		const searchDialog = screen.getByRole('dialog', { name: 'Search chats...' });
		expect(searchDialog.parentElement).toBe(document.body);

		await fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

		await waitFor(() => {
			expect(document.querySelector('[data-search-dialog-content][data-state="open"]')).toBeNull();
		});
		expect(screen.getByRole('button', { name: 'Search chats...' })).toBeTruthy();
	});

	it('closes the saved-search manager opened from the search dialog on drawer close', async () => {
		const chats = [createChat({ id: 'chat-1', title: 'Chat one' })];
		const sidebarSearch = createSidebarSearchStore({
			getTranscriptSearchEnabled: () => false,
			getSearchResultSort: () => 'relevance',
			getChats: () => chats,
			getSelectedChatId: () => null,
			notifyError: vi.fn(),
			getSavedSearches: vi.fn().mockResolvedValue({ savedSearches: [] }),
		});
		sidebarSearch.setSavedSearches([createSavedSearch('unread', 'Unread', 'status:unread')]);
		render(MobileSidebarLifecycleHost, { chats, sidebarSearch });

		await fireEvent.click(screen.getByRole('button', { name: 'Search chats...' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Manage searches' }));

		await fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

		expect(sidebarSearch.searchDialogOpen).toBe(false);
		expect(sidebarSearch.managerOpen).toBe(false);
		await waitFor(() => {
			expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
		});
	});
});
