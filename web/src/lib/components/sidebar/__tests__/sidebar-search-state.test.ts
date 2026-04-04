import { describe, expect, it } from 'vitest';

import { SidebarSearchState } from '../sidebar-search-state.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SavedChatSearch } from '$lib/api/settings';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		title: 'Test chat',
		provider: 'claude',
		model: 'sonnet',
		permissionMode: 'default',
		thinkingMode: 'none',
		claudeThinkingMode: 'auto',
		ampAgentMode: 'smart' as const,
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

function createState(chats: ChatSessionRecord[] = [], selectedChatId: string | null = null) {
	return new SidebarSearchState({
		get chats() { return chats; },
		get selectedChatId() { return selectedChatId; },
	});
}

describe('SidebarSearchState', () => {
	describe('dialog lifecycle', () => {
			it('opens search dialog, seeds the draft query, and highlights the selected chat when present', () => {
				const chats = [
					makeChat({ id: 'c1', title: 'First chat' }),
					makeChat({ id: 'c2', title: 'Second chat' }),
				];
				const searchState = createState(chats, 'c2');
				searchState.activeQuery = '';
				searchState.highlightedResultIndex = 5;
				searchState.openSearchDialog();

				expect(searchState.searchDialogOpen).toBe(true);
				expect(searchState.draftQuery).toBe('');
				expect(searchState.highlightedResultIndex).toBe(1);
			});

			it('falls back to the first result when the selected chat is not in the filtered dialog results', () => {
				const searchState = createState();
				searchState.activeQuery = 'status:unread';
				searchState.highlightedResultIndex = 5;
				searchState.openSearchDialog();

				expect(searchState.searchDialogOpen).toBe(true);
				expect(searchState.draftQuery).toBe('status:unread');
				expect(searchState.highlightedResultIndex).toBe(0);
			});

			it('closes search dialog as cancel and restores the applied query into draft state', () => {
				const searchState = createState();
				searchState.activeQuery = 'status:active';
				searchState.openSearchDialog();
				searchState.updateDraftQuery('tag:ops');
				searchState.highlightedResultIndex = 3;
				searchState.closeSearchDialog();

				expect(searchState.searchDialogOpen).toBe(false);
				expect(searchState.activeQuery).toBe('status:active');
				expect(searchState.draftQuery).toBe('status:active');
				expect(searchState.highlightedResultIndex).toBe(0);
			});

		it('openSearchDialog does not affect manager dialog state', () => {
			const searchState = createState();
			searchState.manageSavedSearchesOpen = true;
			searchState.openSearchDialog();

			expect(searchState.searchDialogOpen).toBe(true);
				expect(searchState.manageSavedSearchesOpen).toBe(true);
			});

			it('suspends search dialog without discarding the draft query', () => {
				const searchState = createState();
				searchState.openSearchDialog();
				searchState.updateDraftQuery('tag:ops');

				searchState.suspendSearchDialog();

				expect(searchState.searchDialogOpen).toBe(false);
				expect(searchState.draftQuery).toBe('tag:ops');
			});

			it('toggleSearchDialog closes when open and reopens from the applied query when closed', () => {
				const searchState = createState();
				searchState.activeQuery = 'status:unread';

				searchState.toggleSearchDialog();
				expect(searchState.searchDialogOpen).toBe(true);
				expect(searchState.draftQuery).toBe('status:unread');

				searchState.updateDraftQuery('tag:ops');
				searchState.toggleSearchDialog();
				expect(searchState.searchDialogOpen).toBe(false);
				expect(searchState.draftQuery).toBe('status:unread');
			});
		});

		describe('applyQuery', () => {
		it('sets activeQuery and resets highlight', () => {
			const searchState = createState();
			searchState.highlightedResultIndex = 2;
			searchState.applyQuery('status:unread');

			expect(searchState.activeQuery).toBe('status:unread');
			expect(searchState.highlightedResultIndex).toBe(0);
		});

		it('filters chats by the applied query', () => {
			const chats = [
				makeChat({ id: 'c1', isUnread: true, tags: ['ops'] }),
				makeChat({ id: 'c2', isUnread: false, tags: ['dev'] }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('tag:ops');
			expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1']);
		});

			it('returns all chats when query is empty', () => {
			const chats = [
				makeChat({ id: 'c1' }),
				makeChat({ id: 'c2' }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('');
			expect(searchState.filteredChats).toHaveLength(2);
			});

			it('does not change the applied query when only the draft query changes', () => {
				const searchState = createState();
				searchState.applyQuery('status:active');

				searchState.openSearchDialog();
				searchState.updateDraftQuery('tag:ops');

				expect(searchState.activeQuery).toBe('status:active');
			});

			it('confirms the draft query into the applied query', () => {
				const searchState = createState();
				searchState.applyQuery('status:active');
				searchState.openSearchDialog();
				searchState.updateDraftQuery('tag:ops');

				searchState.confirmSearchDialog();

				expect(searchState.searchDialogOpen).toBe(false);
				expect(searchState.activeQuery).toBe('tag:ops');
			});
		});

		describe('dialogFilteredChats', () => {
			it('filters chats using the draft query instead of the applied query', () => {
				const chats = [
					makeChat({ id: 'c1', isUnread: true, tags: ['ops'] }),
					makeChat({ id: 'c2', isUnread: false, tags: ['dev'] }),
				];
				const searchState = createState(chats);
				searchState.applyQuery('status:unread');
				searchState.openSearchDialog();
				searchState.updateDraftQuery('tag:dev');

				expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1']);
				expect(searchState.dialogFilteredChats.map((c) => c.id)).toEqual(['c2']);
			});
		});

	describe('isFiltered', () => {
		it('returns false when query is empty', () => {
			const searchState = createState();
			expect(searchState.isFiltered).toBe(false);
		});

		it('returns true when query is non-empty', () => {
			const searchState = createState();
			searchState.applyQuery('hello');
			expect(searchState.isFiltered).toBe(true);
		});

		it('returns false when query is whitespace-only', () => {
			const searchState = createState();
			searchState.applyQuery('   ');
			expect(searchState.isFiltered).toBe(false);
		});
	});

	describe('sidebarPillSearches', () => {
		it('returns only searches with showAsSidebarPill true', () => {
			const searchState = createState();
			searchState.setSavedSearches([
				makeSavedSearch({ id: 's1', showAsSidebarPill: true, title: 'Quick' }),
				makeSavedSearch({ id: 's2', showAsSidebarPill: false }),
				makeSavedSearch({ id: 's3', showAsSidebarPill: true, title: 'Also Quick' }),
			]);

			expect(searchState.sidebarPillSearches.map((s) => s.id)).toEqual(['s1', 's3']);
		});

		it('returns empty array when no searches are marked for sidebar pills', () => {
			const searchState = createState();
			searchState.setSavedSearches([
				makeSavedSearch({ id: 's1', showAsSidebarPill: false }),
			]);

			expect(searchState.sidebarPillSearches).toEqual([]);
		});
	});

	describe('sidebarMenuSearches', () => {
		it('returns only searches with showInSidebarMenu true', () => {
			const searchState = createState();
			searchState.setSavedSearches([
				makeSavedSearch({ id: 's1', showInSidebarMenu: true }),
				makeSavedSearch({ id: 's2', showInSidebarMenu: false }),
				makeSavedSearch({ id: 's3', showInSidebarMenu: true }),
			]);

			expect(searchState.sidebarMenuSearches.map((s) => s.id)).toEqual(['s1', 's3']);
		});
	});

	describe('searchDialogSavedSearches', () => {
		it('returns only searches with showInSearchDialog true', () => {
			const searchState = createState();
			searchState.setSavedSearches([
				makeSavedSearch({ id: 's1', showInSearchDialog: true }),
				makeSavedSearch({ id: 's2', showInSearchDialog: false }),
				makeSavedSearch({ id: 's3', showInSearchDialog: true }),
			]);

			expect(searchState.searchDialogSavedSearches.map((s) => s.id)).toEqual(['s1', 's3']);
		});
	});

	describe('hasActiveQuery', () => {
		it('returns true when activeQuery is non-empty', () => {
			const searchState = createState();
			searchState.applyQuery('status:active');
			expect(searchState.hasActiveQuery).toBe(true);
		});

		it('returns false when activeQuery is empty', () => {
			const searchState = createState();
			expect(searchState.hasActiveQuery).toBe(false);
		});
	});

	describe('allKnownTags', () => {
		it('collects and deduplicates tags from all chats', () => {
			const chats = [
				makeChat({ id: 'c1', tags: ['ops', 'bugs'] }),
				makeChat({ id: 'c2', tags: ['ops', 'dev'] }),
			];
			const searchState = createState(chats);

			expect(searchState.allKnownTags).toEqual(['bugs', 'dev', 'ops']);
		});
	});

	describe('setSavedSearches', () => {
		it('replaces the full saved searches list', () => {
			const searchState = createState();
			const searches = [
				makeSavedSearch({ id: 's1' }),
				makeSavedSearch({ id: 's2' }),
			];
			searchState.setSavedSearches(searches);

			expect(searchState.savedSearches).toHaveLength(2);
			expect(searchState.savedSearches[0].id).toBe('s1');
		});
	});

	describe('status filter integration', () => {
		it('filters by status:unread', () => {
			const chats = [
				makeChat({ id: 'c1', isUnread: true }),
				makeChat({ id: 'c2', isUnread: false }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('status:unread');
			expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1']);
		});

		it('filters by status:active', () => {
			const chats = [
				makeChat({ id: 'c1', isProcessing: true }),
				makeChat({ id: 'c2', isProcessing: false }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('status:active');
			expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1']);
		});
	});
});
