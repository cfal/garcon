import { describe, expect, it } from 'vitest';

import { SidebarSearchState } from '../sidebar-search-state.svelte';
import type { ChatSessionRecord } from '$lib/types/chat-session';

function makeChat(overrides: Partial<ChatSessionRecord>): ChatSessionRecord {
	return {
		id: 'chat-1',
		projectPath: '/workspace/project',
		title: 'Test chat',
		agentId: 'claude',
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

function createState(chats: ChatSessionRecord[] = [], selectedChatId: string | null = null) {
	return new SidebarSearchState({
		get chats() {
			return chats;
		},
		get selectedChatId() {
			return selectedChatId;
		},
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

		it('suspends search dialog without discarding the draft query', () => {
			const searchState = createState();
			searchState.openSearchDialog();
			searchState.updateDraftQuery('tag:ops');

			searchState.suspendSearchDialog();

			expect(searchState.searchDialogOpen).toBe(false);
			expect(searchState.draftQuery).toBe('tag:ops');
		});

		it('resumes search dialog without discarding the suspended draft query', () => {
			const chats = [
				makeChat({ id: 'c1', title: 'First chat' }),
				makeChat({ id: 'c2', title: 'Second chat' }),
			];
			const searchState = createState(chats, 'c2');
			searchState.openSearchDialog();
			searchState.updateDraftQuery('tag:ops');

			searchState.suspendSearchDialog();
			searchState.resumeSearchDialog();

			expect(searchState.searchDialogOpen).toBe(true);
			expect(searchState.draftQuery).toBe('tag:ops');
			expect(searchState.highlightedResultIndex).toBe(0);
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
			const chats = [makeChat({ id: 'c1' }), makeChat({ id: 'c2' })];
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

	describe('project filter integration', () => {
		it('filters by project: substring match', () => {
			const chats = [
				makeChat({ id: 'c1', projectPath: '/workspace/garcon' }),
				makeChat({ id: 'c2', projectPath: '/workspace/other' }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('project:garcon');
			expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1']);
		});

		it('combines multiple project: filters as OR', () => {
			const chats = [
				makeChat({ id: 'c1', projectPath: '/workspace/garcon' }),
				makeChat({ id: 'c2', projectPath: '/workspace/other' }),
				makeChat({ id: 'c3', projectPath: '/workspace/third' }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('project:garcon project:other');
			expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1', 'c2']);
		});

		it('combines project with tag filter', () => {
			const chats = [
				makeChat({ id: 'c1', projectPath: '/workspace/garcon', tags: ['ops'] }),
				makeChat({ id: 'c2', projectPath: '/workspace/garcon', tags: ['dev'] }),
				makeChat({ id: 'c3', projectPath: '/workspace/other', tags: ['ops'] }),
			];
			const searchState = createState(chats);

			searchState.applyQuery('project:garcon tag:ops');
			expect(searchState.filteredChats.map((c) => c.id)).toEqual(['c1']);
		});
	});
});
