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
		showInQuickMenu: false,
		createdAt: '2026-03-27T00:00:00.000Z',
		updatedAt: '2026-03-27T00:00:00.000Z',
		...overrides,
	};
}

function createState(chats: ChatSessionRecord[] = []) {
	return new SidebarSearchState({
		get chats() { return chats; },
	});
}

describe('SidebarSearchState', () => {
	describe('dialog lifecycle', () => {
		it('opens search dialog and resets highlight index', () => {
			const searchState = createState();
			searchState.highlightedResultIndex = 5;
			searchState.openSearchDialog();

			expect(searchState.searchDialogOpen).toBe(true);
			expect(searchState.highlightedResultIndex).toBe(0);
		});

		it('closes search dialog and resets highlight index', () => {
			const searchState = createState();
			searchState.openSearchDialog();
			searchState.highlightedResultIndex = 3;
			searchState.closeSearchDialog();

			expect(searchState.searchDialogOpen).toBe(false);
			expect(searchState.highlightedResultIndex).toBe(0);
		});

		it('openSearchDialog does not affect manager dialog state', () => {
			const searchState = createState();
			searchState.manageSavedSearchesOpen = true;
			searchState.openSearchDialog();

			expect(searchState.searchDialogOpen).toBe(true);
			expect(searchState.manageSavedSearchesOpen).toBe(true);
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

	describe('quickMenuSearches', () => {
		it('returns only searches with showInQuickMenu true', () => {
			const searchState = createState();
			searchState.setSavedSearches([
				makeSavedSearch({ id: 's1', showInQuickMenu: true, title: 'Quick' }),
				makeSavedSearch({ id: 's2', showInQuickMenu: false }),
				makeSavedSearch({ id: 's3', showInQuickMenu: true, title: 'Also Quick' }),
			]);

			expect(searchState.quickMenuSearches.map((s) => s.id)).toEqual(['s1', 's3']);
		});

		it('returns empty array when no searches are marked for quick menu', () => {
			const searchState = createState();
			searchState.setSavedSearches([
				makeSavedSearch({ id: 's1', showInQuickMenu: false }),
			]);

			expect(searchState.quickMenuSearches).toEqual([]);
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
