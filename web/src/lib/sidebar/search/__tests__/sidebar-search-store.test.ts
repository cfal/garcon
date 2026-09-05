import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createSidebarSearchStore,
	transcriptSearchCandidateSignature,
	transcriptSearchContentRevisionSignature,
	type SidebarSearchStoreDeps,
} from '$lib/sidebar/search/sidebar-search-store.svelte.js';
import type { SavedChatSearch } from '$lib/api/settings';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { ApiError } from '$lib/api/client';
import type { TranscriptSearchStatusV1 } from '$shared/chat-search';
import type { ChatSearchPage, ChatSearchResponse } from '$shared/chat-search';

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
		agentSettings: { ownerId: 'claude', schemaVersion: 1, values: {} },
		createdAt: null,
		lastActivityAt: '2026-03-27T08:00:00.000Z',
		lastReadAt: null,
		isPinned: false,
		isArchived: false,
		isProcessing: false,
		processingPhase: null,
		isUnread: false,
		canReloadFromNativeHistory: false,
		status: 'running',
		tags: [],
		...overrides,
		parentChat: overrides.parentChat ?? null,
		agentOwnershipEpoch: overrides.agentOwnershipEpoch ?? null,
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
		getSearchResultSort: () => 'relevance',
		getChats: () => chats,
		getSelectedChatId: () => selectedChatId,
		notifyError,
		logError,
		...overrides,
	});
	return { store, notifyError, logError };
}

function makeStatus(
	overrides: Partial<TranscriptSearchStatusV1> = {},
): TranscriptSearchStatusV1 {
	return {
		version: 1,
		phase: 'rebuilding',
		chats: { total: 1, indexed: 0, pending: 1, failed: 0, unindexed: 0 },
		queuedJobs: 1,
		resync: { completedChats: 0, totalChats: 1 },
		backlogRows: 1,
		activeChat: null,
		lastErrorCode: null,
		updatedAt: '2026-08-19T00:00:00.000Z',
		...overrides,
	};
}

function makeSearchPage(
	total: number,
	overrides: Partial<ChatSearchPage> = {},
): ChatSearchPage {
	return { offset: 0, limit: 50, total, hasMore: false, nextOffset: null, ...overrides };
}

function makeSearchResult(chatId: string) {
	return {
		chatId,
		transcriptViewId: `view-${chatId}`,
		score: 1,
		matchedMessageCount: 1,
		snippets: [],
	};
}

function makeSearchResponse(
	results: ChatSearchResponse['results'],
	page: ChatSearchPage,
): ChatSearchResponse {
	return {
		query: 'needle',
		results,
		page,
		index: {
			indexedChatCount: results.length,
			pendingChatCount: 0,
			failedChatCount: 0,
			unindexedChatCount: 0,
			unsupportedChatCount: 0,
			resultsTruncated: false,
		},
	};
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

		it('indexes the selected chat in the exact time-sorted dialog projection', () => {
			const chats = [
				makeChat({ id: 'older', createdAt: '2026-01-01T00:00:00.000Z' }),
				makeChat({ id: 'newer', createdAt: '2026-02-01T00:00:00.000Z' }),
			];
			const { store } = createStore(chats, 'older', {
				getSearchResultSort: () => 'created',
			});

			store.openSearchDialog();

			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['newer', 'older']);
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

		it.each(['close', 'confirm'] as const)(
			'keeps an aligned first-page search alive when the dialog actions %s',
			async (action) => {
				const response = Promise.withResolvers<ChatSearchResponse>();
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockReturnValue(response.promise);
				const { store } = createStore([makeChat({ id: 'c1' })], null, {
					searchChatTranscripts,
				});
				store.activeQuery = 'needle';
				store.openSearchDialog();
				const pending = store.refreshTranscriptSearch('needle');

				if (action === 'close') store.closeSearchDialog();
				else store.confirmSearchDialog();
				response.resolve(makeSearchResponse([makeSearchResult('c1')], makeSearchPage(1)));
				await pending;

				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
				expect(store.transcriptSearchPage).toEqual(makeSearchPage(1));
			},
		);

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

		it('owns the reset sequence for search-result sort changes', () => {
			const { store } = createStore([makeChat({ id: 'c1' })]);
			store.highlightedResultIndex = 4;
			store.transcriptSearchResultsResetVersion = 2;
			store.transcriptSearchQuery = 'needle';
			store.transcriptSearchResults = [makeSearchResult('c1')];
			store.transcriptSearchPage = makeSearchPage(1);

			store.resetTranscriptSearchForSortChange();

			expect(store.highlightedResultIndex).toBe(0);
			expect(store.transcriptSearchResultsResetVersion).toBe(3);
			expect(store.transcriptSearchQuery).toBe('');
			expect(store.transcriptSearchResults).toEqual([]);
			expect(store.transcriptSearchPage).toBeNull();
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

		it('filters by chat order group', () => {
			const chats = [
				makeChat({ id: 'pinned', orderGroup: 'pinned', isPinned: true }),
				makeChat({ id: 'normal' }),
				makeChat({ id: 'archived', orderGroup: 'archived', isArchived: true }),
			];
			const { store } = createStore(chats);

			store.applyQuery('is:pinned');

			expect(store.filteredChats.map((chat) => chat.id)).toEqual(['pinned']);

			store.openSearchDialog();
			store.updateDraftQuery('is:!archived');
			expect(store.dialogFilteredChats.map((chat) => chat.id)).toEqual(['pinned', 'normal']);
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
							transcriptViewId: 'view-1',
							score: 1,
							matchedMessageCount: 1,
							snippets: [
								{
									ordinal: 2,
									role: 'assistant',
									timestamp: null,
									text: 'needle appears in the transcript',
								},
							],
						},
					],
					page: makeSearchPage(1),
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
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

		it('searches transcripts within is: filter candidates', async () => {
			const chats = [
				makeChat({ id: 'pinned', orderGroup: 'pinned', isPinned: true }),
				makeChat({ id: 'normal' }),
				makeChat({ id: 'archived', orderGroup: 'archived', isArchived: true }),
			];
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue({
					query: 'needle is:!archived',
					results: [],
					page: makeSearchPage(0),
					index: {
						indexedChatCount: 2,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				});
			const { store } = createStore(chats, null, { searchChatTranscripts });

			await store.refreshTranscriptSearch('needle is:!archived');

			expect(searchChatTranscripts).toHaveBeenCalledWith(
				expect.objectContaining({
					textTokens: ['needle'],
					chatIds: ['pinned', 'normal'],
				}),
				expect.any(Object),
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
				unindexedChatCount: 0,
				unsupportedChatCount: 0,
				resultsTruncated: false,
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
				transcriptViewId: 'view-1',
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

		it('[TLV5-SEARCH.09-UI-01] retries one timeout after exactly one second', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockRejectedValueOnce(new ApiError(
					503,
					'Transcript search timed out',
					'SEARCH_TIMEOUT',
					undefined,
					true,
				))
				.mockResolvedValueOnce({
					query: 'needle',
					results: [],
					page: makeSearchPage(0),
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				});
			const waitForTranscriptIndexRetry = vi.fn(async () => undefined);
			const { store, logError } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
				waitForTranscriptIndexRetry,
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
			expect(waitForTranscriptIndexRetry).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
			expect(store.transcriptSearchError).toBeNull();
			expect(logError).not.toHaveBeenCalled();
		});

		it('retries a temporarily unavailable index', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockRejectedValueOnce(new ApiError(
					503,
					'Transcript search is restarting',
					'SEARCH_INDEX_UNAVAILABLE',
					undefined,
					true,
				))
				.mockResolvedValueOnce({
					query: 'needle',
					results: [],
					page: makeSearchPage(0),
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
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

		it('[TLV5-SEARCH.09-UI-02] surfaces a busy index after one retry', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockRejectedValue(new ApiError(
					503,
					'Transcript search is busy',
					'SEARCH_INDEX_BUSY',
					undefined,
					true,
				));
			const { store, logError } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
				waitForTranscriptIndexRetry: async () => undefined,
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
			expect(store.transcriptSearchError).not.toBeNull();
			expect(logError).toHaveBeenCalledTimes(1);
		});

		it('[TLV5-SEARCH.09-UI-03] parks pending results until a terminal status refresh', async () => {
			vi.useFakeTimers();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce({
					query: 'needle',
					results: [],
					page: makeSearchPage(0),
					index: {
						indexedChatCount: 0,
						pendingChatCount: 1,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				})
				.mockResolvedValueOnce({
					query: 'needle',
					results: [
						{
							chatId: 'c1',
							transcriptViewId: 'view-1',
							score: 1,
							matchedMessageCount: 1,
							snippets: [],
						},
					],
					page: makeSearchPage(1),
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				});
			try {
				const waitForTranscriptIndexRetry = vi.fn(async () => undefined);
				const { store } = createStore([makeChat({ id: 'c1' })], null, {
					searchChatTranscripts,
					waitForTranscriptIndexRetry,
				});

				await store.refreshTranscriptSearch('needle');

				expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
				expect(waitForTranscriptIndexRetry).not.toHaveBeenCalled();
				expect(store.transcriptSearchIndexing).toBe(true);

				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'ready',
					chats: { total: 1, indexed: 1, pending: 0, failed: 0, unindexed: 0 },
					queuedJobs: 0,
					resync: null,
					backlogRows: 0,
				}));
				await vi.runAllTimersAsync();

				expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
				expect(store.transcriptSearchIndex?.pendingChatCount).toBe(0);
				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
				expect(store.transcriptSearchIndexing).toBe(false);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('[TLV5-SEARCH.09-UI-04] does not poll without status progress', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue({
					query: 'needle',
					results: [],
					page: makeSearchPage(0),
					index: {
						indexedChatCount: 0,
						pendingChatCount: 1,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				});
			const waitForTranscriptIndexRetry = vi.fn(async () => undefined);
			const { store } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
				waitForTranscriptIndexRetry,
			});

			await store.refreshTranscriptSearch('needle');
			store.applyTranscriptSearchStatus(makeStatus());

			expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
			expect(waitForTranscriptIndexRetry).not.toHaveBeenCalled();
			expect(store.transcriptSearchLoading).toBe(false);
			expect(store.transcriptSearchIndexing).toBe(true);
			expect(store.transcriptSearchStatus).toEqual(makeStatus());
			store.destroy();
		});

		it('[TLV5-SEARCH.09-UI-05] coalesces progress refreshes and flushes terminal status', async () => {
			vi.useFakeTimers();
			try {
				const pending = {
					query: 'needle',
					results: [],
					page: makeSearchPage(0),
					index: {
						indexedChatCount: 0,
						pendingChatCount: 1,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				};
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockResolvedValue(pending);
				const { store } = createStore([makeChat({ id: 'c1' })], null, {
					searchChatTranscripts,
				});
				await store.refreshTranscriptSearch('needle');

				for (const indexed of [1, 2, 3]) {
					store.applyTranscriptSearchStatus(makeStatus({
						chats: { total: indexed + 1, indexed, pending: 1, failed: 0, unindexed: 0 },
					}));
				}
				await vi.advanceTimersByTimeAsync(499);
				expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
				await vi.advanceTimersByTimeAsync(1);
				expect(searchChatTranscripts).toHaveBeenCalledTimes(2);

				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'degraded',
					chats: { total: 4, indexed: 3, pending: 0, failed: 1, unindexed: 0 },
					queuedJobs: 0,
					resync: null,
					backlogRows: 0,
				}));
				await vi.runAllTimersAsync();
				expect(searchChatTranscripts).toHaveBeenCalledTimes(3);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
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

		it('ignores stale success without cancelling the current search', async () => {
			const staleResponse = Promise.withResolvers<ChatSearchResponse>();
			const currentResponse = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockReturnValueOnce(staleResponse.promise)
				.mockReturnValueOnce(currentResponse.promise);
			const { store } = createStore([
				makeChat({ id: 'c1' }),
				makeChat({ id: 'c2' }),
			], null, { searchChatTranscripts });

			const staleSearch = store.refreshTranscriptSearch('stale');
			const currentSearch = store.refreshTranscriptSearch('current');
			const currentSignal = searchChatTranscripts.mock.calls[1]?.[1]?.signal;
			staleResponse.resolve(makeSearchResponse(
				[makeSearchResult('c1')],
				makeSearchPage(1),
			));
			await staleSearch;

			expect(currentSignal?.aborted).toBe(false);
			currentResponse.resolve(makeSearchResponse(
				[makeSearchResult('c2')],
				makeSearchPage(1),
			));
			await currentSearch;

			expect(store.transcriptSearchQuery).toBe('current');
			expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c2']);
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
							transcriptViewId: 'view-2',
							score: 1,
							matchedMessageCount: 1,
							snippets: [
								{
									ordinal: 4,
									role: 'user',
									timestamp: null,
									text: 'needle was only in the chat body',
								},
							],
						},
					],
					page: makeSearchPage(1),
					index: {
						indexedChatCount: 2,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
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
							transcriptViewId: 'view-1',
							score: 1,
							matchedMessageCount: 1,
							snippets: [],
						},
					],
					page: makeSearchPage(1),
					index: {
						indexedChatCount: 1,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
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
			const deferred = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce({
					query: 'needle',
					results: [
						{
							chatId: 'c2',
							transcriptViewId: 'view-2',
							score: 1,
							matchedMessageCount: 1,
							snippets: [
								{
									ordinal: 4,
									role: 'user',
									timestamp: null,
									text: 'needle was only in the chat body',
								},
							],
						},
					],
					page: makeSearchPage(1),
					index: {
						indexedChatCount: 2,
						pendingChatCount: 0,
						failedChatCount: 0,
						unindexedChatCount: 0,
						unsupportedChatCount: 0,
						resultsTruncated: false,
					},
				})
				.mockReturnValueOnce(deferred.promise);
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');
			expect(searchChatTranscripts).toHaveBeenCalledWith(
				expect.objectContaining({ chatIds: ['c1', 'c2'] }),
				expect.any(Object),
			);
			expect([...store.transcriptSearchResultsByChatId.keys()]).toEqual(['c2']);
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['c2']);

			store.updateDraftQuery('other');
			const pending = store.refreshTranscriptSearch('other');
			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual([]);

			deferred.resolve({
				query: 'other',
				results: [],
				page: makeSearchPage(0),
				index: {
					indexedChatCount: 2,
					pendingChatCount: 0,
					failedChatCount: 0,
					unindexedChatCount: 0,
					unsupportedChatCount: 0,
					resultsTruncated: false,
				},
			});
			await pending;
		});
	});

	describe('transcript search invalidation', () => {
		it('separates candidate membership from content revisions', () => {
			const chat = makeChat({ id: 'c1', tags: ['ops'], lastActivityAt: null });
			const query = 'needle tag:ops';
			const membership = transcriptSearchCandidateSignature([chat], query);
			const content = transcriptSearchContentRevisionSignature([chat], query);
			const activityChange = { ...chat, lastActivityAt: '2026-03-27T09:00:00.000Z' };
			expect(transcriptSearchCandidateSignature([activityChange], query)).toBe(membership);
			expect(transcriptSearchContentRevisionSignature([activityChange], query)).not.toBe(content);
			expect(transcriptSearchCandidateSignature([{ ...chat, tags: ['dev'] }], query))
				.not.toBe(membership);
		});

		it('does not apply a stale time frontier while the draft query is ahead', async () => {
			const chats = [
				makeChat({ id: 'loaded', title: 'Needle transcript' }),
				makeChat({ id: 'metadata', title: 'Other metadata result' }),
			];
			const { store } = createStore(chats, null, {
				getSearchResultSort: () => 'activity',
				searchChatTranscripts: async () => makeSearchResponse(
					[makeSearchResult('loaded')],
					makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
				),
			});
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');

			store.updateDraftQuery('other');

			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(['metadata']);
		});

		it('keeps the committed time order stable until revalidation succeeds', async () => {
			const chats = Array.from({ length: 60 }, (_, index) => makeChat({
				id: `c${String(index).padStart(2, '0')}`,
				createdAt: '2026-01-01T00:00:00.000Z',
				lastActivityAt: '2026-01-01T00:00:00.000Z',
			}));
			const { store } = createStore(chats, null, {
				getSearchResultSort: () => 'activity',
				searchChatTranscripts: async () => makeSearchResponse(
					chats.slice(0, 50).map((chat) => makeSearchResult(chat.id)),
					makeSearchPage(60, { hasMore: true, nextOffset: 50 }),
				),
			});
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');
			store.highlightedResultIndex = 30;
			const displayedBeforeActivity = store.dialogDisplayChats.map((chat) => chat.id);

			chats[40].lastActivityAt = '2026-09-05T00:00:00.000Z';
			store.scheduleTranscriptSearchRevalidation();

			expect(store.dialogDisplayChats.map((chat) => chat.id)).toEqual(displayedBeforeActivity);
			expect(store.dialogDisplayChats[store.highlightedResultIndex]?.id)
				.toBe(displayedBeforeActivity[30]);
			store.destroy();
		});
	});

	describe('transcript search pagination', () => {
		it('sends an explicit first-page contract and skips title-only transcript searches', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue(makeSearchResponse([], makeSearchPage(0)));
			const { store } = createStore([makeChat({ id: 'c1', title: 'Needle title' })], null, {
				searchChatTranscripts,
				getSearchResultSort: () => 'activity',
			});

			await store.refreshTranscriptSearch('needle');

			expect(searchChatTranscripts).toHaveBeenCalledWith({
				query: 'needle',
				textTokens: ['needle'],
				chatIds: ['c1'],
				sort: 'activity',
				offset: 0,
				limit: 50,
			}, { signal: expect.any(AbortSignal) });

			await store.refreshTranscriptSearch('title:Needle');
			expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
			expect(store.transcriptSearchPage).toBeNull();
		});

		it('uses the server cursor, single-flights demand, and deduplicates live overlap', async () => {
			const nextPage = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(101, { hasMore: true, nextOffset: 50 }),
				))
				.mockReturnValueOnce(nextPage.promise);
			const chats = [makeChat({ id: 'c1' }), makeChat({ id: 'c2' })];
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');

			const firstDemand = store.loadMoreTranscriptResults();
			const repeatedDemand = store.loadMoreTranscriptResults();

			expect(repeatedDemand).toBe(firstDemand);
			expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
			expect(searchChatTranscripts.mock.calls[1]?.[0]).toMatchObject({ offset: 50, limit: 50 });
			const nextPageResponse = makeSearchResponse(
				[makeSearchResult('c1'), makeSearchResult('c2')],
				makeSearchPage(101, { offset: 50, hasMore: true, nextOffset: 100 }),
			);
			nextPageResponse.index.pendingChatCount = 1;
			nextPage.resolve(nextPageResponse);
			await firstDemand;

			expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1', 'c2']);
			expect(store.transcriptSearchPage?.nextOffset).toBe(100);
			expect(store.transcriptSearchIndexing).toBe(true);
			expect(store.transcriptSearchLoadingMore).toBe(false);
		});

		it('invalidates an in-flight page immediately when the draft query changes', async () => {
			const nextPage = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
				))
				.mockReturnValueOnce(nextPage.promise);
			const { store } = createStore([
				makeChat({ id: 'c1' }),
				makeChat({ id: 'c2' }),
			], null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');
			store.highlightedResultIndex = 1;
			const pending = store.loadMoreTranscriptResults();
			const pageSignal = searchChatTranscripts.mock.calls[1]?.[1]?.signal;

			store.updateDraftQuery('replacement');

			expect(pageSignal?.aborted).toBe(true);
			expect(store.highlightedResultIndex).toBe(0);
			expect(store.transcriptSearchResults).toEqual([]);
			nextPage.resolve(makeSearchResponse(
				[makeSearchResult('c2')],
				makeSearchPage(100, { offset: 50, hasMore: true, nextOffset: 100 }),
			));
			await pending;
			expect(store.transcriptSearchResults).toEqual([]);
		});

		it('preserves a user highlight changed while a page is loading', async () => {
			const chats = Array.from({ length: 100 }, (_, index) => makeChat({ id: `c${index}` }));
			const nextPage = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					chats.slice(0, 50).map((chat) => makeSearchResult(chat.id)),
					makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
				))
				.mockReturnValueOnce(nextPage.promise);
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');
			store.highlightedResultIndex = 42;
			const pending = store.loadMoreTranscriptResults();
			store.highlightedResultIndex = 49;

			nextPage.resolve(makeSearchResponse(
				chats.slice(50).map((chat) => makeSearchResult(chat.id)),
				makeSearchPage(100, { offset: 50 }),
			));
			await pending;

			expect(store.highlightedResultIndex).toBe(49);
			expect(store.dialogDisplayChats[49]?.id).toBe('c49');
		});

		it('does not load another page after the draft query changes', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValue(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
				));
			const { store } = createStore([makeChat({ id: 'c1' })], null, {
				searchChatTranscripts,
			});
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');

			store.updateDraftQuery('replacement');
			await store.loadMoreTranscriptResults();

			expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
			expect(store.canLoadMoreTranscriptResults).toBe(false);
		});

		it('remounts identical live announcements for consecutive metadata overlaps', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(150, { hasMore: true, nextOffset: 50 }),
				))
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c2')],
					makeSearchPage(150, { offset: 50, hasMore: true, nextOffset: 100 }),
				))
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(150, { offset: 100 }),
				));
			const { store } = createStore([
				makeChat({ id: 'c1', title: 'Needle one' }),
				makeChat({ id: 'c2', title: 'Needle two' }),
			], null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');

			await store.loadMoreTranscriptResults();
			const firstAnnouncement = store.transcriptSearchAnnouncement;
			expect(store.transcriptSearchAnnouncementVersion).toBe(1);
			await store.loadMoreTranscriptResults();

			expect(store.transcriptSearchAnnouncement).toBe(firstAnnouncement);
			expect(store.transcriptSearchAnnouncementVersion).toBe(2);
		});

		it('preserves loaded rows after a page failure and retries the same offset', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(75, { hasMore: true, nextOffset: 50 }),
				))
				.mockRejectedValueOnce(new Error('page failed'))
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c2')],
					makeSearchPage(75, { offset: 50 }),
				));
			const { store } = createStore(
				[makeChat({ id: 'c1' }), makeChat({ id: 'c2' })],
				null,
				{ searchChatTranscripts },
			);
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');

			await store.loadMoreTranscriptResults();
			expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
			expect(store.transcriptSearchPageError).toBeTruthy();
			expect(store.transcriptSearchPage?.nextOffset).toBe(50);

			await store.loadMoreTranscriptResults();
			expect(searchChatTranscripts.mock.calls[1]?.[0].offset).toBe(50);
			expect(searchChatTranscripts.mock.calls[2]?.[0].offset).toBe(50);
			expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1', 'c2']);
			expect(store.transcriptSearchPageError).toBeNull();
		});

		it('stops at the first 500 logical positions even when deduplication yields fewer rows', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(600, { offset: 400, hasMore: true, nextOffset: 450 }),
				))
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1'), makeSearchResult('c2')],
					makeSearchPage(600, { offset: 450, hasMore: true, nextOffset: 500 }),
				));
			const { store } = createStore(
				[makeChat({ id: 'c1' }), makeChat({ id: 'c2' })],
				null,
				{ searchChatTranscripts },
			);
			store.updateDraftQuery('needle');
			await store.refreshTranscriptSearch('needle');
			await store.loadMoreTranscriptResults();

			expect(store.transcriptSearchLimitReached).toBe(true);
			expect(store.canLoadMoreTranscriptResults).toBe(false);
			expect(store.transcriptSearchResults).toHaveLength(2);
			await store.loadMoreTranscriptResults();
			expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
		});

		it('limits a non-aligned final request to the remaining logical positions', async () => {
			const chats = Array.from({ length: 600 }, (_, index) => makeChat({ id: `c${index}` }));
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockImplementation(async (request) => {
					const offset = request.offset ?? 0;
					const limit = request.limit ?? 50;
					const end = Math.min(600, offset + limit);
					return makeSearchResponse(
						chats.slice(offset, end).map((chat) => makeSearchResult(chat.id)),
						makeSearchPage(600, {
							offset,
							limit,
							hasMore: end < 600,
							nextOffset: end < 600 ? end : null,
						}),
					);
				});
			const { store } = createStore(chats, null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			store.transcriptSearchQuery = 'needle';
			store.transcriptSearchResults = chats.slice(0, 475).map((chat) => makeSearchResult(chat.id));
			store.transcriptSearchPage = makeSearchPage(475, {
				offset: 450,
				limit: 25,
			});

			await store.retryTranscriptSearchRevalidation();
			await store.loadMoreTranscriptResults();

			const finalRequest = searchChatTranscripts.mock.calls.at(-1)?.[0];
			expect(finalRequest).toMatchObject({ offset: 475, limit: 25 });
			expect(store.transcriptSearchResults).toHaveLength(500);
			expect(store.transcriptSearchPage?.nextOffset).toBe(500);
			expect(store.transcriptSearchLimitReached).toBe(true);
		});

		it('drains a content invalidation received during the initial page', async () => {
			vi.useFakeTimers();
			try {
				const initialPage = Promise.withResolvers<ChatSearchResponse>();
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockReturnValueOnce(initialPage.promise)
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c1')],
						makeSearchPage(1),
					));
				const { store } = createStore([makeChat({ id: 'c1' })], null, {
					searchChatTranscripts,
				});
				store.updateDraftQuery('needle');
				const pending = store.refreshTranscriptSearch('needle');

				store.scheduleTranscriptSearchRevalidation();
				initialPage.resolve(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(1),
				));
				await pending;
				await vi.advanceTimersByTimeAsync(500);

				expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('drains index progress received before a pending initial page settles', async () => {
			vi.useFakeTimers();
			try {
				const initialPage = Promise.withResolvers<ChatSearchResponse>();
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockReturnValueOnce(initialPage.promise)
					.mockResolvedValueOnce(makeSearchResponse([], makeSearchPage(0)));
				const { store } = createStore([makeChat({ id: 'c1' })], null, {
					searchChatTranscripts,
				});
				store.applyTranscriptSearchStatus(makeStatus());
				store.updateDraftQuery('needle');
				const pending = store.refreshTranscriptSearch('needle');

				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'ready',
					chats: { total: 1, indexed: 1, pending: 0, failed: 0, unindexed: 0 },
				}));
				const response = makeSearchResponse([], makeSearchPage(0));
				response.index.pendingChatCount = 1;
				initialPage.resolve(response);
				await pending;
				await vi.advanceTimersByTimeAsync(500);

				expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('atomically revalidates the loaded logical prefix in 100-result chunks', async () => {
			vi.useFakeTimers();
			try {
				const firstChunk = Promise.withResolvers<ChatSearchResponse>();
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockReturnValueOnce(firstChunk.promise)
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c3')],
						makeSearchPage(300, { offset: 100, limit: 100, hasMore: true, nextOffset: 200 }),
					))
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c1')],
						makeSearchPage(300, { offset: 200, hasMore: true, nextOffset: 250 }),
					));
				const chats = ['c1', 'c2', 'c3'].map((id) => makeChat({ id }));
				const { store } = createStore(chats, null, { searchChatTranscripts });
				store.updateDraftQuery('needle');
				store.transcriptSearchQuery = 'needle';
				store.transcriptSearchResults = [makeSearchResult('c1'), makeSearchResult('c2')];
				store.transcriptSearchPage = makeSearchPage(300, {
					offset: 200,
					hasMore: true,
					nextOffset: 250,
				});

				store.scheduleTranscriptSearchRevalidation();
				await vi.advanceTimersByTimeAsync(500);
				expect(store.transcriptSearchRevalidating).toBe(true);
				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1', 'c2']);
				expect(searchChatTranscripts.mock.calls[0]?.[0]).toMatchObject({ offset: 0, limit: 100 });

				firstChunk.resolve(makeSearchResponse(
					[makeSearchResult('c2')],
					makeSearchPage(300, { limit: 100, hasMore: true, nextOffset: 100 }),
				));
				await vi.runAllTimersAsync();

				expect(searchChatTranscripts.mock.calls.map(([request]) => request.offset)).toEqual([0, 100, 200]);
				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c2', 'c3', 'c1']);
				expect(store.transcriptSearchRevalidating).toBe(false);
				expect(store.transcriptSearchRevalidationVersion).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it('preserves a user highlight changed while revalidation is loading', async () => {
			const refreshed = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockReturnValue(refreshed.promise);
			const { store } = createStore([
				makeChat({ id: 'c1' }),
				makeChat({ id: 'c2' }),
				makeChat({ id: 'c3' }),
			], null, { searchChatTranscripts });
			store.updateDraftQuery('needle');
			store.transcriptSearchQuery = 'needle';
			store.transcriptSearchResults = [
				makeSearchResult('c1'),
				makeSearchResult('c2'),
				makeSearchResult('c3'),
			];
			store.transcriptSearchPage = makeSearchPage(3, { limit: 3 });
			store.highlightedResultIndex = 0;
			const pending = store.retryTranscriptSearchRevalidation();
			store.highlightedResultIndex = 2;

			refreshed.resolve(makeSearchResponse([
				makeSearchResult('c3'),
				makeSearchResult('c2'),
				makeSearchResult('c1'),
			], makeSearchPage(3, { limit: 3 })));
			await pending;

			expect(store.highlightedResultIndex).toBe(0);
			expect(store.dialogDisplayChats[store.highlightedResultIndex]?.id).toBe('c3');
			store.destroy();
		});

		it('retains loaded results and blocks paging until a failed revalidation is retried', async () => {
			vi.useFakeTimers();
			try {
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockRejectedValueOnce(new Error('revalidation failed'))
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c2')],
						makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
					));
				const { store, logError } = createStore([
					makeChat({ id: 'c1' }),
					makeChat({ id: 'c2' }),
				], null, { searchChatTranscripts });
				store.updateDraftQuery('needle');
				store.transcriptSearchQuery = 'needle';
				store.transcriptSearchResults = [makeSearchResult('c1')];
				store.transcriptSearchPage = makeSearchPage(100, {
					hasMore: true,
					nextOffset: 50,
				});

				store.scheduleTranscriptSearchRevalidation();
				await vi.advanceTimersByTimeAsync(500);

				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
				expect(store.transcriptSearchPage?.nextOffset).toBe(50);
				expect(store.transcriptSearchRevalidationError).toBeTruthy();
				expect(store.canLoadMoreTranscriptResults).toBe(false);
				expect(logError).toHaveBeenCalledWith(
					'Failed to update transcript search results:',
					expect.any(Error),
				);

				await store.retryTranscriptSearchRevalidation();

				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c2']);
				expect(store.transcriptSearchRevalidationError).toBeNull();
				expect(store.canLoadMoreTranscriptResults).toBe(true);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('surfaces a revalidation deadline without logging its abort and allows retry', async () => {
			vi.useFakeTimers();
			try {
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockImplementationOnce((_request, options) => new Promise((_resolve, reject) => {
						options?.signal?.addEventListener('abort', () => {
							reject(new DOMException('Search aborted', 'AbortError'));
						}, { once: true });
					}))
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c2')],
						makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
					));
				const { store, logError } = createStore([
					makeChat({ id: 'c1' }),
					makeChat({ id: 'c2' }),
				], null, { searchChatTranscripts });
				store.updateDraftQuery('needle');
				store.transcriptSearchQuery = 'needle';
				store.transcriptSearchResults = [makeSearchResult('c1')];
				store.transcriptSearchPage = makeSearchPage(100, {
					hasMore: true,
					nextOffset: 50,
				});

				store.scheduleTranscriptSearchRevalidation();
				await vi.advanceTimersByTimeAsync(500);
				expect(store.transcriptSearchRevalidating).toBe(true);
				await vi.advanceTimersByTimeAsync(5_000);

				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
				expect(store.transcriptSearchRevalidationError).toBeTruthy();
				expect(store.canLoadMoreTranscriptResults).toBe(false);
				expect(logError).not.toHaveBeenCalled();

				await store.retryTranscriptSearchRevalidation();

				expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c2']);
				expect(store.transcriptSearchRevalidationError).toBeNull();
				expect(store.canLoadMoreTranscriptResults).toBe(true);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not revalidate a query with no candidate chats', async () => {
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>();
			const { store } = createStore([makeChat({ id: 'c1', title: 'Alpha' })], null, {
				searchChatTranscripts,
			});
			store.updateDraftQuery('needle title:missing');
			await store.refreshTranscriptSearch('needle title:missing');

			await store.retryTranscriptSearchRevalidation();

			expect(searchChatTranscripts).not.toHaveBeenCalled();
			expect(store.transcriptSearchPage).toEqual(makeSearchPage(0));
			expect(store.transcriptSearchRevalidating).toBe(false);
		});

		it('ignores status churn and unrelated global progress after the query is fully indexed', async () => {
			vi.useFakeTimers();
			try {
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockResolvedValue(makeSearchResponse([], makeSearchPage(0)));
				const { store } = createStore([makeChat({ id: 'c1' })], null, {
					searchChatTranscripts,
				});
				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'ready',
					chats: { total: 10, indexed: 10, pending: 0, failed: 0, unindexed: 0 },
				}));
				await store.refreshTranscriptSearch('needle');

				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'ready',
					chats: { total: 10, indexed: 10, pending: 0, failed: 0, unindexed: 0 },
					queuedJobs: 4,
					backlogRows: 8,
				}));
				await vi.advanceTimersByTimeAsync(500);
				expect(searchChatTranscripts).toHaveBeenCalledTimes(1);

				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'ready',
					chats: { total: 11, indexed: 11, pending: 0, failed: 0, unindexed: 0 },
				}));
				await vi.advanceTimersByTimeAsync(500);
				expect(searchChatTranscripts).toHaveBeenCalledTimes(1);

				store.applyTranscriptSearchStatus(makeStatus({
					phase: 'rebuilding',
					chats: { total: 12, indexed: 11, pending: 1, failed: 0, unindexed: 0 },
				}));
				await vi.advanceTimersByTimeAsync(500);
				expect(searchChatTranscripts).toHaveBeenCalledTimes(1);
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('runs a revalidation delayed by an in-flight page request', async () => {
			vi.useFakeTimers();
			try {
				const page = Promise.withResolvers<ChatSearchResponse>();
				const searchChatTranscripts = vi
					.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c1')],
						makeSearchPage(2, { hasMore: true, nextOffset: 50 }),
					))
					.mockReturnValueOnce(page.promise)
					.mockResolvedValueOnce(makeSearchResponse(
						[makeSearchResult('c1'), makeSearchResult('c2')],
						makeSearchPage(2, { limit: 2 }),
					));
				const { store } = createStore(
					[makeChat({ id: 'c1' }), makeChat({ id: 'c2' })],
					null,
					{ searchChatTranscripts },
				);
				store.updateDraftQuery('needle');
				await store.refreshTranscriptSearch('needle');
				store.scheduleTranscriptSearchRevalidation();
				const pendingPage = store.loadMoreTranscriptResults();

				await vi.advanceTimersByTimeAsync(500);
				expect(searchChatTranscripts).toHaveBeenCalledTimes(2);
				page.resolve(makeSearchResponse(
					[makeSearchResult('c2')],
					makeSearchPage(2, { offset: 50 }),
				));
				await pendingPage;
				await vi.advanceTimersByTimeAsync(500);

				expect(searchChatTranscripts).toHaveBeenCalledTimes(3);
				expect(searchChatTranscripts.mock.calls[2]?.[0]).toMatchObject({ offset: 0, limit: 2 });
				store.destroy();
			} finally {
				vi.useRealTimers();
			}
		});

		it('cancels page work on close and rejects its late response', async () => {
			const page = Promise.withResolvers<ChatSearchResponse>();
			const searchChatTranscripts = vi
				.fn<NonNullable<SidebarSearchStoreDeps['searchChatTranscripts']>>()
				.mockResolvedValueOnce(makeSearchResponse(
					[makeSearchResult('c1')],
					makeSearchPage(100, { hasMore: true, nextOffset: 50 }),
				))
				.mockReturnValueOnce(page.promise);
			const { store } = createStore(
				[makeChat({ id: 'c1' }), makeChat({ id: 'c2' })],
				null,
				{ searchChatTranscripts },
			);
			await store.refreshTranscriptSearch('needle');
			const pending = store.loadMoreTranscriptResults();
			store.closeSearchDialog();
			expect(store.transcriptSearchLoadingMore).toBe(false);
			expect(store.transcriptSearchPageError).toBeNull();

			page.resolve(makeSearchResponse(
				[makeSearchResult('c2')],
				makeSearchPage(100, { offset: 50 }),
			));
			await pending;
			expect(store.transcriptSearchResults.map((result) => result.chatId)).toEqual(['c1']);
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

describe('openTranscriptResult', () => {
	function resultFor(chatId: string) {
		return {
			chatId,
			transcriptViewId: 'view-1',
			score: 1,
			matchedMessageCount: 1,
			snippets: [{
				ordinal: 4,
				role: 'assistant' as const,
				text: 'needle',
				highlights: [],
				timestamp: '2026-01-01T00:00:00.000Z',
			}],
		};
	}

	function navigationStore(overrides: Partial<SidebarSearchStoreDeps> = {}) {
		const store = createSidebarSearchStore({
			getChats: () => [makeChat({ id: 'chat-1' })],
			getSelectedChatId: () => null,
			getTranscriptSearchEnabled: () => true,
			getSearchResultSort: () => 'relevance',
			notifyError: vi.fn(),
			...overrides,
		});
		store.transcriptSearchResults = [resultFor('chat-1')];
		return store;
	}

	it('resolves the view-qualified snippet and opens at its seq', async () => {
		const navigate = vi.fn(async () => ({ chatId: 'chat-1', ordinal: 4 }));
		const store = navigationStore({ navigateToSearchResult: navigate });
		const opened = vi.fn();

		await store.openTranscriptResult('chat-1', opened);

		expect(navigate).toHaveBeenCalledWith({
			chatId: 'chat-1',
			transcriptViewId: 'view-1',
			ordinal: 4,
		});
		expect(opened).toHaveBeenCalledWith('chat-1', 4);
	});

	it('removes a stale result, requeries, and opens without a seq', async () => {
		const navigate = vi.fn(async () => {
			throw new ApiError(409, 'stale', 'SEARCH_RESULT_STALE');
		});
		const search = vi.fn(async () => ({
			query: 'needle',
			results: [],
			page: makeSearchPage(0),
			index: {
				indexedChatCount: 1,
				pendingChatCount: 0,
				failedChatCount: 0,
				unindexedChatCount: 0,
				unsupportedChatCount: 0,
				resultsTruncated: false,
			},
		}));
		const store = navigationStore({
			navigateToSearchResult: navigate,
			searchChatTranscripts: search,
		});
		store.transcriptSearchQuery = 'needle';
		const opened = vi.fn();

		await store.openTranscriptResult('chat-1', opened);

		expect(store.transcriptSearchResults).toEqual([]);
		expect(opened).toHaveBeenCalledWith('chat-1', null);
		expect(search).toHaveBeenCalled();
	});

	it('opens a chat without a transcript snippet directly', async () => {
		const navigate = vi.fn();
		const store = navigationStore({ navigateToSearchResult: navigate });
		store.transcriptSearchResults = [];
		const opened = vi.fn();

		await store.openTranscriptResult('chat-1', opened);

		expect(navigate).not.toHaveBeenCalled();
		expect(opened).toHaveBeenCalledWith('chat-1', null);
	});
});
