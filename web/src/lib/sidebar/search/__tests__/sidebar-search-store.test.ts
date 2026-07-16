import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createSidebarSearchStore,
	transcriptSearchFacetSignature,
	type SidebarSearchStoreDeps,
} from '$lib/sidebar/search/sidebar-search-store.svelte.js';
import type { SavedChatSearch } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { ApiError } from '$lib/api/client';

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
		getTranscriptSearchEnabled: () => true,
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

		it('searches transcripts within structured filter candidates', async () => {
			const chats = [
				makeChat({ id: 'c1', title: 'Alpha', tags: ['ops'] }),
				makeChat({ id: 'c2', title: 'Beta', tags: ['dev'] }),
			];
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue({
					query: 'needle tag:ops',
					results: [
						{
							chatId: 'c1',
							score: 1,
							matchedMessageCount: 1,
							snippets: [
								{
									messageOrdinal: 2,
									role: 'assistant',
									timestamp: null,
									text: 'needle appears in the transcript',
								},
							],
						},
					],
					total: 1,
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				});
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle tag:ops');

			await store.refreshTranscriptSearch('needle tag:ops');

			expect(searchChatTranscripts).toHaveBeenCalledWith(
				expect.objectContaining({
					query: 'needle tag:ops',
					textTokens: ['needle'],
					chatIds: ['c1'],
				}),
				expect.any(Object),
			);
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['c1']);
			expect(store.transcriptSearchResultsByChatId.get('c1')?.snippets[0]?.text).toContain(
				'needle',
			);
		});

		it('short-circuits transcript search when structured filters have no candidates', async () => {
			const searchChatTranscripts =
				vi.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>();
			const { store } = createStore([makeChat({ id: 'c1', tags: ['dev'] })], null, {
				searchChatTranscripts,
			});

			await store.refreshTranscriptSearch('needle tag:ops');

			expect(searchChatTranscripts).not.toHaveBeenCalled();
			expect(store.transcriptSearchResults).toEqual([]);
			expect(store.transcriptSearchIndex).toEqual({
				indexedChatCount: 0,
				pendingChatCount: 0,
				failedChatCount: 0,
				unsupportedChatCount: 0,
			});
		});

		it('does not call the transcript API while the feature is disabled', async () => {
			const searchChatTranscripts = vi.fn();
			const { store } = createStore([makeChat({ id: 'c1' })], null, {
				getTranscriptSearchEnabled: () => false,
				searchChatTranscripts,
			});
			store.transcriptSearchResults = [{
				chatId: 'c1',
				score: 1,
				matchedMessageCount: 1,
				snippets: [],
			}];

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).not.toHaveBeenCalled();
			expect(store.transcriptSearchResults).toEqual([]);
			expect(store.transcriptSearchError).toBeNull();
		});

		it('silently clears a disabled race response without retrying', async () => {
			const searchChatTranscripts = vi.fn().mockRejectedValue(new ApiError(
				409,
				'Transcript search is disabled',
				'TRANSCRIPT_SEARCH_DISABLED',
				undefined,
				false,
			));
			const { store, logError } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
			expect(store.transcriptSearchError).toBeNull();
			expect(logError).not.toHaveBeenCalled();
		});

		it('retries a busy search without surfacing an error', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockRejectedValueOnce(new ApiError(
					503,
					'Transcript search is busy',
					'SEARCH_INDEX_BUSY',
					undefined,
					true,
				))
				.mockResolvedValueOnce({
					query: 'needle',
					results: [],
					total: 0,
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				});
			const waitForTranscriptIndexRetry = vi.fn(async () => undefined);
			const { store, logError } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
				waitForTranscriptIndexRetry,
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
			expect(waitForTranscriptIndexRetry).toHaveBeenCalledTimes(1);
			expect(store.transcriptSearchError).toBeNull();
			expect(logError).not.toHaveBeenCalled();
		});

		it('polls bounded index progress until pending chats become searchable', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce({
					query: 'needle',
					results: [],
					total: 0,
					index: {
						indexedChatCount: 0,
						pendingChatCount: 1,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				})
				.mockResolvedValueOnce({
					query: 'needle',
					results: [
						{
							chatId: 'c1',
							score: 1,
							matchedMessageCount: 1,
							snippets: [],
						},
					],
					total: 1,
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				});
			const waitForTranscriptIndexRetry = vi.fn(async () => undefined);
			const { store } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
				waitForTranscriptIndexRetry,
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
			expect(waitForTranscriptIndexRetry).toHaveBeenCalledTimes(1);
			expect(store.transcriptSearchIndex).toEqual({
				indexedChatCount: 1,
				pendingChatCount: 0,
				failedChatCount: 0,
				unsupportedChatCount: 0,
			});
			expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
			expect(store.transcriptSearchIndexing).toBe(false);
		});

		it('stops polling incomplete startup indexing after a bounded number of attempts', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue({
					query: 'needle',
					results: [],
					total: 0,
					index: {
						indexedChatCount: 0,
						pendingChatCount: 1,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				});
			const waitForTranscriptIndexRetry = vi.fn(async () => undefined);
			const { store } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
				waitForTranscriptIndexRetry,
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledTimes(4);
			expect(waitForTranscriptIndexRetry).toHaveBeenCalledTimes(3);
			expect(store.transcriptSearchLoading).toBe(false);
			expect(store.transcriptSearchIndexing).toBe(false);
		});

		it('surfaces localized failures but treats aborts as silent cancellation', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockRejectedValueOnce(new Error('raw backend failure'))
				.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
			const { store, logError } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
			});

			await store.refreshTranscriptSearch('needle');
			expect(store.transcriptSearchError).toBeTruthy();
			expect(store.transcriptSearchError).not.toContain('raw backend failure');
			expect(logError).toHaveBeenCalledTimes(1);

			await store.refreshTranscriptSearch('other');
			expect(store.transcriptSearchError).toBeNull();
			expect(logError).toHaveBeenCalledTimes(1);
		});

		it('adds transcript-only matches after metadata matches for the same query', async () => {
			const chats = [
				makeChat({ id: 'c1', title: 'needle in title' }),
				makeChat({ id: 'c2', title: 'Hidden match' }),
			];
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue({
					query: 'needle',
					results: [
						{
							chatId: 'c2',
							score: 1,
							matchedMessageCount: 1,
							snippets: [
								{
									messageOrdinal: 4,
									role: 'user',
									timestamp: null,
									text: 'needle was only in the chat body',
								},
							],
						},
					],
					total: 1,
					index: {
						indexedChatCount: 2,
						pendingChatCount: 0,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				});
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle');

			await store.refreshTranscriptSearch('needle');

			expect(store.dialogFilteredChats.map((chat) => chat.id)).toEqual(['c1']);
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['c1', 'c2']);
		});

		it('removes cached transcript matches when live facet metadata stops matching', async () => {
			const chats = [makeChat({ id: 'c1', title: 'Hidden match', tags: ['ops'] })];
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue({
					query: 'needle tag:ops',
					results: [
						{
							chatId: 'c1',
							score: 1,
							matchedMessageCount: 1,
							snippets: [],
						},
					],
					total: 1,
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				});
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle tag:ops');
			await store.refreshTranscriptSearch('needle tag:ops');
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['c1']);

			chats[0] = makeChat({ id: 'c1', title: 'Hidden match', tags: ['dev'] });
			expect(store.dialogDisplayChats).toEqual([]);
		});

		it('clears stale transcript matches while a new query is loading', async () => {
			const chats = [makeChat({ id: 'c1', title: 'Alpha' }), makeChat({ id: 'c2', title: 'Beta' })];
			const deferred = Promise.withResolvers<{
				query: string;
				results: [];
				total: number;
				index: {
					indexedChatCount: number;
					pendingChatCount: number;
					failedChatCount: number;
					unsupportedChatCount: number;
				};
			}>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce({
					query: 'needle',
					results: [
						{
							chatId: 'c2',
							score: 1,
							matchedMessageCount: 1,
							snippets: [
								{
									messageOrdinal: 4,
									role: 'user',
									timestamp: null,
									text: 'needle was only in the chat body',
								},
							],
						},
					],
					total: 1,
					index: {
						indexedChatCount: 2,
						pendingChatCount: 0,
						failedChatCount: 0,
						unsupportedChatCount: 0,
					},
				})
				.mockReturnValueOnce(deferred.promise);
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['c2']);

			store.updateDraftQuery('other');
			const pending = store.refreshTranscriptSearch('other');
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual([]);

			deferred.resolve({
				query: 'other',
				results: [],
				total: 0,
				index: {
					indexedChatCount: 2,
					pendingChatCount: 0,
					failedChatCount: 0,
					unsupportedChatCount: 0,
				},
			});
			await pending;
		});
	});

	describe('transcript search invalidation', () => {
		it('changes for every field used by structured search facets', () => {
			const chat = makeChat({ id: 'c1' });
			const baseline = transcriptSearchFacetSignature([chat]);
			const changes: Partial<ChatSessionRecord>[] = [
				{ projectPath: '/workspace/other' },
				{ effectiveProjectKey: '/workspace/other' },
				{ projectIdentityState: 'pending' },
				{ agentId: 'codex' },
				{ model: 'gpt-5.6-sol' },
				{ status: 'draft' },
				{ lastActivityAt: '2026-03-27T09:00:00.000Z' },
				{ isProcessing: true },
				{ isUnread: true },
				{ tags: ['ops'] },
			];

			for (const change of changes) {
				expect(transcriptSearchFacetSignature([{ ...chat, ...change }])).not.toBe(baseline);
			}
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
