import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSidebarSearchStore, type SidebarSearchStoreDeps } from '../sidebar-search.svelte';
import type { SavedChatSearch } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		effectiveProjectKey: '/workspace/project',
		projectIdentityState: 'available',
		orderGroup: 'normal',
		title: 'Test chat',
		agentId: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart',
		createdAt: null,
		lastActivityAt: '2026-03-27T08:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		isUnread: false,
		status: 'running',
		tags: [],
		...overrides,
	};
}

function makeSavedSearch(overrides: Partial<SavedChatSearch>): SavedChatSearch {
	return {
		id: 'search-1',
		title: null,
		query: 'status:active',
		showAsSidebarPill: false,
		showInSidebarMenu: false,
		showInSearchDialog: true,
		createdAt: '2026-03-27T00:00:00.000Z',
		updatedAt: '2026-03-27T00:00:00.000Z',
		...overrides,
	};
}

function createStore(
	chats: ChatSessionRecord[] = [],
	selectedChatId: string | null = null,
	overrides: Partial<SidebarSearchStoreDeps> = {},
) {
	const notifyError = vi.fn();
	const logError = vi.fn();
	const store = createSidebarSearchStore({
		getChats: () => chats,
		getSelectedChatId: () => selectedChatId,
		notifyError,
		logError,
		...overrides,
	});
	return { store, notifyError, logError };
}

describe('SidebarSearchStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('dialog lifecycle', () => {
		it('opens search dialog, seeds the draft query, and highlights the selected chat when present', () => {
			const chats = [
				makeChat({ id: 'c1', title: 'First chat' }),
				makeChat({ id: 'c2', title: 'Second chat' }),
			];
			const { store } = createStore(chats, 'c2');
			store.activeQuery = '';
			store.highlightedResultIndex = 5;
			store.openSearchDialog();

			expect(store.searchDialogOpen).toBe(true);
			expect(store.draftQuery).toBe('');
			expect(store.highlightedResultIndex).toBe(1);
		});

		it('closes search dialog as cancel and restores the applied query into draft state', () => {
			const { store } = createStore();
			store.activeQuery = 'status:active';
			store.openSearchDialog();
			store.updateDraftQuery('tag:ops');
			store.highlightedResultIndex = 3;
			store.closeSearchDialog();

			expect(store.searchDialogOpen).toBe(false);
			expect(store.activeQuery).toBe('status:active');
			expect(store.draftQuery).toBe('status:active');
			expect(store.highlightedResultIndex).toBe(0);
		});

		it('suspends and resumes search dialog without discarding the draft query', () => {
			const chats = [
				makeChat({ id: 'c1', title: 'First chat' }),
				makeChat({ id: 'c2', title: 'Second chat' }),
			];
			const { store } = createStore(chats, 'c2');
			store.openSearchDialog();
			store.updateDraftQuery('tag:ops');

			store.suspendSearchDialog();
			expect(store.searchDialogOpen).toBe(false);
			expect(store.draftQuery).toBe('tag:ops');

			store.resumeSearchDialog();
			expect(store.searchDialogOpen).toBe(true);
			expect(store.draftQuery).toBe('tag:ops');
			expect(store.highlightedResultIndex).toBe(0);
		});

		it('toggleSearchDialog closes when open and reopens from the applied query when closed', () => {
			const { store } = createStore();
			store.activeQuery = 'status:unread';

			store.toggleSearchDialog();
			expect(store.searchDialogOpen).toBe(true);
			expect(store.draftQuery).toBe('status:unread');

			store.updateDraftQuery('tag:ops');
			store.toggleSearchDialog();
			expect(store.searchDialogOpen).toBe(false);
			expect(store.draftQuery).toBe('status:unread');
		});
	});

	describe('query filtering', () => {
		it('sets activeQuery, resets highlight, and filters chats by the applied query', () => {
			const chats = [
				makeChat({ id: 'c1', isUnread: true, tags: ['ops'] }),
				makeChat({ id: 'c2', isUnread: false, tags: ['dev'] }),
			];
			const { store } = createStore(chats);
			store.highlightedResultIndex = 2;

			store.applyQuery('tag:ops');

			expect(store.activeQuery).toBe('tag:ops');
			expect(store.highlightedResultIndex).toBe(0);
			expect(store.filteredChats.map((chat) => chat.id)).toEqual(['c1']);
		});

		it('keeps draft filtering separate from the applied query', () => {
			const chats = [
				makeChat({ id: 'c1', isUnread: true, tags: ['ops'] }),
				makeChat({ id: 'c2', isUnread: false, tags: ['dev'] }),
			];
			const { store } = createStore(chats);
			store.applyQuery('status:unread');
			store.openSearchDialog();
			store.updateDraftQuery('tag:dev');

			expect(store.filteredChats.map((chat) => chat.id)).toEqual(['c1']);
			expect(store.dialogFilteredChats.map((chat) => chat.id)).toEqual(['c2']);
		});

		it('reports filtered state and all known tags', () => {
			const chats = [
				makeChat({ id: 'c1', tags: ['ops', 'bugs'] }),
				makeChat({ id: 'c2', tags: ['ops', 'dev'] }),
			];
			const { store } = createStore(chats);

			expect(store.isFiltered).toBe(false);
			store.applyQuery('status:active');
			expect(store.isFiltered).toBe(true);
			expect(store.hasActiveQuery).toBe(true);
			expect(store.allKnownTags).toEqual(['bugs', 'dev', 'ops']);
		});

		it('supports status and project filters', () => {
			const chats = [
				makeChat({ id: 'c1', projectPath: '/workspace/garcon', isProcessing: true, tags: ['ops'] }),
				makeChat({
					id: 'c2',
					projectPath: '/workspace/garcon',
					isProcessing: false,
					tags: ['dev'],
				}),
				makeChat({ id: 'c3', projectPath: '/workspace/other', isProcessing: true, tags: ['ops'] }),
			];
			const { store } = createStore(chats);

			store.applyQuery('status:active project:garcon tag:ops');
			expect(store.filteredChats.map((chat) => chat.id)).toEqual(['c1']);
		});
	});

	describe('saved searches', () => {
		it('dedupes saved-search loads', async () => {
			const savedSearch = makeSavedSearch({
				id: 's1',
				title: 'Quick',
				showAsSidebarPill: true,
			});
			const getSavedSearches = vi
				.fn<NonNullable<SidebarSearchStoreDeps['getSavedSearches']>>()
				.mockResolvedValue({ savedSearches: [savedSearch] });
			const { store } = createStore([], null, { getSavedSearches });

			await Promise.all([store.loadSavedSearches(), store.loadSavedSearches()]);

			expect(getSavedSearches).toHaveBeenCalledTimes(1);
			expect(store.savedSearchesLoaded).toBe(true);
			expect(store.sidebarPillSearches).toEqual([savedSearch]);
		});

		it('reports load failures and allows a later retry', async () => {
			const getSavedSearches = vi
				.fn<NonNullable<SidebarSearchStoreDeps['getSavedSearches']>>()
				.mockRejectedValueOnce(new Error('network'))
				.mockResolvedValueOnce({ savedSearches: [] });
			const { store, notifyError, logError } = createStore([], null, { getSavedSearches });

			await store.loadSavedSearches();
			expect(store.savedSearchesLoaded).toBe(false);
			expect(notifyError).toHaveBeenCalledWith('Failed to load saved searches.');
			expect(logError).toHaveBeenCalledWith('Failed to load saved searches:', expect.any(Error));

			await store.loadSavedSearches();
			expect(getSavedSearches).toHaveBeenCalledTimes(2);
			expect(store.savedSearchesLoaded).toBe(true);
		});

		it('partitions saved searches by display target', () => {
			const { store } = createStore();
			store.setSavedSearches([
				makeSavedSearch({ id: 's1', showAsSidebarPill: true, title: 'Quick' }),
				makeSavedSearch({ id: 's2', showInSidebarMenu: true, showInSearchDialog: false }),
				makeSavedSearch({ id: 's3', showInSearchDialog: true }),
			]);

			expect(store.sidebarPillSearches.map((search) => search.id)).toEqual(['s1']);
			expect(store.sidebarMenuSearches.map((search) => search.id)).toEqual(['s2']);
			expect(store.searchDialogSavedSearches.map((search) => search.id)).toEqual(['s1', 's3']);
		});

		it('suspends and restores the search dialog around create flow', () => {
			const { store } = createStore();
			store.openSearchDialog();
			store.updateDraftQuery('tag:ops');

			store.openEditorForCreateFromSearchDialog();
			expect(store.searchDialogOpen).toBe(false);
			expect(store.editorState?.query).toBe('tag:ops');

			store.closeEditor();
			expect(store.searchDialogOpen).toBe(true);
			expect(store.draftQuery).toBe('tag:ops');
		});

		it('creates and updates searches while restoring manager origin', async () => {
			const created = makeSavedSearch({ id: 'created', query: 'status:unread' });
			const updated = makeSavedSearch({ id: 'created', query: 'tag:ops' });
			const createSavedSearch = vi
				.fn<NonNullable<SidebarSearchStoreDeps['createSavedSearch']>>()
				.mockResolvedValue({ success: true, savedSearch: created });
			const updateSavedSearch = vi
				.fn<NonNullable<SidebarSearchStoreDeps['updateSavedSearch']>>()
				.mockResolvedValue({ success: true, savedSearch: updated });
			const { store } = createStore([], null, { createSavedSearch, updateSavedSearch });

			store.openEditorForCreate();
			await store.saveEditor({
				title: null,
				query: 'status:unread',
				showAsSidebarPill: false,
				showInSidebarMenu: true,
				showInSearchDialog: true,
			});

			expect(store.savedSearches).toEqual([created]);
			expect(store.managerOpen).toBe(true);

			store.openEditorForEdit(created);
			await store.saveEditor(
				{
					title: null,
					query: 'tag:ops',
					showAsSidebarPill: false,
					showInSidebarMenu: true,
					showInSearchDialog: true,
				},
				'created',
			);

			expect(store.savedSearches).toEqual([updated]);
			expect(store.managerOpen).toBe(true);
		});

		it('deletes searches and reports delete failures', async () => {
			const deleteSavedSearch = vi
				.fn<NonNullable<SidebarSearchStoreDeps['deleteSavedSearch']>>()
				.mockResolvedValueOnce({ success: true })
				.mockRejectedValueOnce(new Error('network'));
			const { store, notifyError } = createStore([], null, { deleteSavedSearch });
			store.setSavedSearches([makeSavedSearch({ id: 's1' })]);

			store.requestDelete('s1');
			await store.confirmDelete();
			expect(store.savedSearches).toEqual([]);

			store.setSavedSearches([makeSavedSearch({ id: 's2' })]);
			store.requestDelete('s2');
			await store.confirmDelete();

			expect(store.savedSearches.map((search) => search.id)).toEqual(['s2']);
			expect(notifyError).toHaveBeenCalledWith('Failed to delete saved search.');
		});

		it('rolls optimistic reorder back on failure', async () => {
			const reorderSavedSearches = vi
				.fn<NonNullable<SidebarSearchStoreDeps['reorderSavedSearches']>>()
				.mockRejectedValue(new Error('network'));
			const { store, notifyError } = createStore([], null, { reorderSavedSearches });
			store.setSavedSearches([
				makeSavedSearch({ id: 's1' }),
				makeSavedSearch({ id: 's2' }),
				makeSavedSearch({ id: 's3' }),
			]);

			await store.reorder(['s1', 's2', 's3'], ['s3', 's1', 's2']);

			expect(store.savedSearches.map((search) => search.id)).toEqual(['s1', 's2', 's3']);
			expect(notifyError).toHaveBeenCalledWith('Failed to reorder saved searches.');
		});
	});
});
