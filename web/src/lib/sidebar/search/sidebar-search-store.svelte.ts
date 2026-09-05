// App-session sidebar search state. Owns active filtering, search dialog state,
// and saved-search CRUD so mobile drawer remounts do not reset search context.

import {
	createSavedSearch,
	deleteSavedSearch as deleteSavedSearchApi,
	getSavedSearches,
	reorderSavedSearches as reorderSavedSearchesApi,
	updateSavedSearch as updateSavedSearchApi,
	type SavedChatSearch,
} from '$lib/api/settings';
import {
	navigateToSearchResult as navigateToSearchResultApi,
	searchChatTranscripts as searchChatTranscriptsApi,
} from '$lib/api/chats';
import { ApiError } from '$lib/api/client';
import {
	isEmptyFilter,
	matchesChatFilter,
	parseChatSearch,
	type ChatFilterSpec,
} from '$lib/sidebar/search/sidebar-search.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import * as m from '$lib/paraglide/messages.js';
import {
	sortChatSearchResults,
	visibleChatSearchTimePrefix,
} from '$lib/sidebar/search/search-result-order.js';
import { compareChatOrderNewestFirst } from '$shared/chat-order-sort';
import type {
	ChatSearchIndexStatus,
	ChatSearchPage,
	ChatSearchRequest,
	ChatSearchResult,
	ChatSearchResponse,
	ChatSearchSort,
	TranscriptSearchStatusV1,
} from '$shared/chat-search';
import { CHAT_SEARCH_MAX_PAGE_SIZE } from '$shared/chat-search';

export interface SavedSearchEditorState {
	mode: 'create' | 'edit';
	searchId?: string;
	title: string;
	query: string;
	showAsSidebarPill: boolean;
	showInSidebarMenu: boolean;
	showInSearchDialog: boolean;
}

export interface SavedSearchInput {
	title: string | null;
	query: string;
	showAsSidebarPill: boolean;
	showInSidebarMenu: boolean;
	showInSearchDialog: boolean;
}

type SavedSearchDialogOrigin = 'manager' | 'search-dialog';

export interface SidebarSearchStoreDeps {
	getChats: () => ChatSessionRecord[];
	getSelectedChatId: () => string | null;
	getTranscriptSearchEnabled: () => boolean;
	getSearchResultSort: () => ChatSearchSort;
	notifyError: (message: string) => void;
	logError?: (message: string, error: unknown) => void;
	getSavedSearches?: typeof getSavedSearches;
	createSavedSearch?: typeof createSavedSearch;
	updateSavedSearch?: typeof updateSavedSearchApi;
	deleteSavedSearch?: typeof deleteSavedSearchApi;
	reorderSavedSearches?: typeof reorderSavedSearchesApi;
	searchChatTranscripts?: (
		request: ChatSearchRequest,
		options?: { signal?: AbortSignal },
	) => Promise<ChatSearchResponse>;
	navigateToSearchResult?: typeof navigateToSearchResultApi;
	waitForTranscriptIndexRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface TranscriptSearchPageRequest {
	query: string;
	textTokens: string[];
	chatIds: string[];
	sort?: ChatSearchSort;
	offset: number;
	limit: number;
	signal?: AbortSignal;
}

const TRANSCRIPT_SEARCH_MAX_ATTEMPTS = 2;
const TRANSCRIPT_SEARCH_RETRY_DELAY_MS = 1_000;
const TRANSCRIPT_SEARCH_PAGE_SIZE = 50;
const TRANSCRIPT_SEARCH_LOADED_LIMIT = 500;
const TRANSCRIPT_SEARCH_REVALIDATION_DELAY_MS = 500;
const TRANSCRIPT_SEARCH_REVALIDATION_TIMEOUT_MS = 5_000;

export class SidebarSearchStore {
	activeQuery = $state('');
	draftQuery = $state('');
	searchDialogOpen = $state(false);
	highlightedResultIndex = $state(0);

	savedSearches = $state<SavedChatSearch[]>([]);
	savedSearchesLoaded = $state(false);
	savedSearchesLoading = $state(false);
	managerOpen = $state(false);
	editorState = $state<SavedSearchEditorState | null>(null);
	deleteConfirmation = $state<{ id: string } | null>(null);
	deleteButtonRef = $state<HTMLButtonElement | null>(null);
	transcriptSearchQuery = $state('');
	transcriptSearchResults = $state<ChatSearchResult[]>([]);
	transcriptSearchIndex = $state<ChatSearchIndexStatus | null>(null);
	transcriptSearchLoading = $state(false);
	transcriptSearchIndexing = $state(false);
	transcriptSearchError = $state<string | null>(null);
	transcriptSearchStatus = $state<TranscriptSearchStatusV1 | null>(null);
	transcriptSearchPage = $state<ChatSearchPage | null>(null);
	transcriptSearchLoadingMore = $state(false);
	transcriptSearchPageError = $state<string | null>(null);
	transcriptSearchAnnouncement = $state('');
	transcriptSearchAnnouncementVersion = $state(0);
	transcriptSearchResultsResetVersion = $state(0);
	transcriptSearchRevalidating = $state(false);
	transcriptSearchRevalidationError = $state<string | null>(null);
	transcriptSearchRevalidationVersion = $state(0);

	private managerOrigin = $state<'search-dialog' | null>(null);
	private editorOrigin = $state<SavedSearchDialogOrigin | null>(null);
	private loadPromise: Promise<void> | null = null;
	private transcriptSearchRequestId = 0;
	private transcriptSearchAbort: AbortController | null = null;
	private transcriptSearchPagePromise: Promise<void> | null = null;
	private transcriptSearchRevalidationPromise: Promise<void> | null = null;
	private transcriptSearchRevalidationTimer: ReturnType<typeof setTimeout> | null = null;
	private transcriptSearchRevalidationDirty = false;

	constructor(private readonly deps: SidebarSearchStoreDeps) {}

	get parsedQuery(): ChatFilterSpec {
		return parseChatSearch(this.activeQuery);
	}

	get parsedDraftQuery(): ChatFilterSpec {
		return parseChatSearch(this.draftQuery);
	}

	get filteredChats(): ChatSessionRecord[] {
		const filter = this.parsedQuery;
		const chats = this.deps.getChats();
		const metadataMatches = isEmptyFilter(filter)
			? chats
			: chats.filter((chat) => matchesChatFilter(chat, filter));
		return this.mergeTranscriptMatches(this.activeQuery, metadataMatches);
	}

	get dialogFilteredChats(): ChatSessionRecord[] {
		const filter = this.parsedDraftQuery;
		const chats = this.deps.getChats();
		if (isEmptyFilter(filter)) return chats;
		return chats.filter((chat) => matchesChatFilter(chat, filter));
	}

	get dialogDisplayChats(): ChatSessionRecord[] {
		const sort = this.deps.getSearchResultSort();
		const sorted = sortChatSearchResults(
			this.mergeTranscriptMatches(this.draftQuery, this.dialogFilteredChats),
			sort,
		);
		if (sort === 'relevance' || this.transcriptSearchQuery !== this.draftQuery) return sorted;
		return visibleChatSearchTimePrefix(
			sorted,
			new Set(this.transcriptSearchResults.map((result) => result.chatId)),
			this.transcriptSearchPage?.hasMore === true && !this.transcriptSearchLimitReached,
		);
	}

	get transcriptSearchResultsByChatId(): Map<string, ChatSearchResult> {
		return new Map(this.transcriptSearchResults.map((result) => [result.chatId, result]));
	}

	get canLoadMoreTranscriptResults(): boolean {
		const nextOffset = this.transcriptSearchPage?.nextOffset;
		return this.transcriptSearchQuery === this.draftQuery
			&& this.transcriptSearchPage?.hasMore === true
			&& nextOffset !== null
			&& nextOffset !== undefined
			&& nextOffset < TRANSCRIPT_SEARCH_LOADED_LIMIT
			&& !this.transcriptSearchLoading
			&& !this.transcriptSearchLoadingMore
			&& !this.transcriptSearchRevalidating
			&& !this.transcriptSearchRevalidationError;
	}

	get transcriptSearchLimitReached(): boolean {
		const nextOffset = this.transcriptSearchPage?.nextOffset;
		return this.transcriptSearchPage?.hasMore === true
			&& nextOffset !== null
			&& nextOffset !== undefined
			&& nextOffset >= TRANSCRIPT_SEARCH_LOADED_LIMIT;
	}

	// Revalidates the transcript view before scrolling to a durable row.
	async openTranscriptResult(
		chatId: string,
		onOpen: (chatId: string, seq: number | null) => void,
	): Promise<void> {
		const result = this.transcriptSearchResultsByChatId.get(chatId);
		const snippet = result?.snippets[0];
		if (!result || !snippet) {
			onOpen(chatId, null);
			return;
		}
		try {
			const resolved = await (this.deps.navigateToSearchResult ?? navigateToSearchResultApi)({
				chatId,
				transcriptViewId: result.transcriptViewId,
				ordinal: snippet.ordinal,
			});
			onOpen(chatId, resolved.ordinal);
		} catch (error) {
			if (error instanceof ApiError && error.errorCode === 'SEARCH_RESULT_STALE') {
				this.transcriptSearchResults = this.transcriptSearchResults.filter(
					(entry) => entry.chatId !== chatId,
				);
				void this.refreshTranscriptSearch(this.transcriptSearchQuery);
			} else {
				this.deps.logError?.('Search result navigation failed', error);
			}
			onOpen(chatId, null);
		}
	}

	get isFiltered(): boolean {
		return this.activeQuery.trim().length > 0;
	}

	get hasActiveQuery(): boolean {
		return this.activeQuery.trim().length > 0;
	}

	get allKnownTags(): string[] {
		const chats = this.deps.getChats();
		return Array.from(new Set(chats.flatMap((chat) => chat.tags))).sort();
	}

	get initialHighlightedResultIndex(): number {
		const selectedChatId = this.deps.getSelectedChatId();
		if (!selectedChatId) return 0;

		const selectedIndex = this.dialogDisplayChats.findIndex((chat) => chat.id === selectedChatId);
		return selectedIndex >= 0 ? selectedIndex : 0;
	}

	get sidebarPillSearches(): SavedChatSearch[] {
		return this.savedSearches.filter((search) => search.showAsSidebarPill);
	}

	get sidebarMenuSearches(): SavedChatSearch[] {
		return this.savedSearches.filter((search) => search.showInSidebarMenu);
	}

	get searchDialogSavedSearches(): SavedChatSearch[] {
		return this.savedSearches.filter((search) => search.showInSearchDialog);
	}

	setSavedSearches(searches: SavedChatSearch[]): void {
		this.savedSearches = searches;
		this.savedSearchesLoaded = true;
	}

	loadSavedSearches(): Promise<void> {
		if (this.savedSearchesLoaded) return Promise.resolve();
		if (this.loadPromise) return this.loadPromise;

		this.savedSearchesLoading = true;
		const load = this.deps.getSavedSearches ?? getSavedSearches;
		this.loadPromise = load()
			.then((result) => {
				this.setSavedSearches(result.savedSearches);
			})
			.catch((error) => {
				this.reportActionFailure(
					'Failed to load saved searches:',
					m.notifications_load_saved_searches_failed(),
					error,
				);
			})
			.finally(() => {
				this.savedSearchesLoading = false;
				this.loadPromise = null;
			});

		return this.loadPromise;
	}

	openSearchDialog(): void {
		this.searchDialogOpen = true;
		this.draftQuery = this.activeQuery;
		this.highlightedResultIndex = this.initialHighlightedResultIndex;
	}

	toggleSearchDialog(): void {
		if (this.searchDialogOpen) {
			this.closeSearchDialog();
			return;
		}
		this.openSearchDialog();
	}

	closeSearchDialog(): void {
		if (this.transcriptSearchQuery !== this.activeQuery) this.cancelTranscriptSearchWork();
		this.searchDialogOpen = false;
		this.draftQuery = this.activeQuery;
		this.highlightedResultIndex = 0;
	}

	suspendSearchDialog(): void {
		this.searchDialogOpen = false;
		this.highlightedResultIndex = 0;
	}

	resumeSearchDialog(): void {
		this.searchDialogOpen = true;
		this.highlightedResultIndex = this.initialHighlightedResultIndex;
	}

	applyQuery(query: string): void {
		this.activeQuery = query;
		this.highlightedResultIndex = 0;
	}

	updateDraftQuery(query: string): void {
		if (query !== this.draftQuery) this.transcriptSearchResultsResetVersion += 1;
		this.draftQuery = query;
		this.highlightedResultIndex = 0;
	}

	resetTranscriptSearchForSortChange(): void {
		this.highlightedResultIndex = 0;
		this.transcriptSearchResultsResetVersion += 1;
		this.clearTranscriptSearch();
	}

	confirmSearchDialog(): void {
		this.activeQuery = this.draftQuery;
		if (this.transcriptSearchQuery !== this.activeQuery) this.cancelTranscriptSearchWork();
		this.searchDialogOpen = false;
		this.highlightedResultIndex = 0;
	}

	openManagerFromSearchDialog(): void {
		this.suspendSearchDialog();
		this.managerOrigin = 'search-dialog';
		this.managerOpen = true;
	}

	closeManager(): void {
		this.managerOpen = false;
		if (this.managerOrigin === 'search-dialog') {
			this.resumeSearchDialog();
		}
		this.managerOrigin = null;
	}

	openEditorForCreate(): void {
		this.managerOpen = false;
		this.editorOrigin = 'manager';
		this.editorState = this.createEditorState(this.draftQuery);
	}

	openEditorForCreateFromSearchDialog(): void {
		this.suspendSearchDialog();
		this.editorOrigin = 'search-dialog';
		this.editorState = this.createEditorState(this.draftQuery);
	}

	openEditorForEdit(search: SavedChatSearch): void {
		this.managerOpen = false;
		this.editorOrigin = 'manager';
		this.editorState = {
			mode: 'edit',
			searchId: search.id,
			title: search.title || '',
			query: search.query,
			showAsSidebarPill: search.showAsSidebarPill,
			showInSidebarMenu: search.showInSidebarMenu,
			showInSearchDialog: search.showInSearchDialog,
		};
	}

	closeEditor(): void {
		this.editorState = null;
		this.restoreEditorOrigin();
	}

	async saveEditor(data: SavedSearchInput, searchId?: string): Promise<void> {
		if (searchId) {
			const updateSearch = this.deps.updateSavedSearch ?? updateSavedSearchApi;
			const result = await updateSearch(searchId, data);
			this.setSavedSearches(
				this.savedSearches.map((search) => (search.id === searchId ? result.savedSearch : search)),
			);
		} else {
			const createSearch = this.deps.createSavedSearch ?? createSavedSearch;
			const result = await createSearch(data);
			this.setSavedSearches([...this.savedSearches, result.savedSearch]);
		}
		this.editorState = null;
		this.restoreEditorOrigin();
	}

	requestDelete(id: string): void {
		this.deleteConfirmation = { id };
	}

	clearDeleteConfirmation(): void {
		this.deleteConfirmation = null;
	}

	async confirmDelete(): Promise<void> {
		if (!this.deleteConfirmation) return;
		const { id } = this.deleteConfirmation;
		this.deleteConfirmation = null;
		try {
			const deleteSearch = this.deps.deleteSavedSearch ?? deleteSavedSearchApi;
			await deleteSearch(id);
			this.setSavedSearches(this.savedSearches.filter((search) => search.id !== id));
		} catch (error) {
			this.reportActionFailure(
				'Failed to delete saved search:',
				m.notifications_delete_saved_search_failed(),
				error,
			);
		}
	}

	async reorder(oldOrder: string[], newOrder: string[]): Promise<void> {
		const byId = new Map(this.savedSearches.map((search) => [search.id, search]));
		this.setSavedSearches(newOrder.map((id) => byId.get(id)).filter(searchExists));
		try {
			const reorderSearches = this.deps.reorderSavedSearches ?? reorderSavedSearchesApi;
			await reorderSearches(oldOrder, newOrder);
		} catch (error) {
			this.reportActionFailure(
				'Failed to reorder saved searches:',
				m.notifications_reorder_saved_searches_failed(),
				error,
			);
			this.setSavedSearches(oldOrder.map((id) => byId.get(id)).filter(searchExists));
		}
	}

	clearTranscriptSearch(): void {
		this.cancelTranscriptSearchWork();
		this.transcriptSearchQuery = '';
		this.transcriptSearchResults = [];
		this.transcriptSearchIndex = null;
		this.transcriptSearchPage = null;
		this.transcriptSearchAnnouncement = '';
		this.transcriptSearchAnnouncementVersion = 0;
		this.transcriptSearchIndexing = false;
		this.transcriptSearchError = null;
	}

	applyTranscriptSearchStatus(status: TranscriptSearchStatusV1): void {
		const previousStatus = this.transcriptSearchStatus;
		this.transcriptSearchStatus = status;
		if (!this.transcriptSearchQuery || !this.transcriptSearchPage) return;
		const searchIndexChanged = this.transcriptSearchIndexing
			&& (previousStatus?.phase !== status.phase
				|| status.chats.indexed > (previousStatus?.chats.indexed ?? -1));
		if (searchIndexChanged) this.scheduleTranscriptSearchRevalidation();
	}

	destroy(): void {
		this.clearTranscriptSearch();
	}

	async refreshTranscriptSearch(
		query = this.transcriptSearchQuery,
		options: { signal?: AbortSignal } = {},
	): Promise<void> {
		if (!this.deps.getTranscriptSearchEnabled()) {
			this.clearTranscriptSearch();
			return;
		}
		const spec = parseChatSearch(query);
		if (spec.textTokens.length === 0) {
			this.clearTranscriptSearch();
			return;
		}

		const candidateChats = this.facetFilteredChats(spec);
		const candidateIds = candidateChats.map((chat) => chat.id);
		this.transcriptSearchAbort?.abort();
		const abort = new AbortController();
		this.transcriptSearchAbort = abort;
		const unlinkAbort = forwardAbort(options.signal, abort);
		const requestId = ++this.transcriptSearchRequestId;
		this.transcriptSearchQuery = query;
		this.transcriptSearchResults = [];
		this.transcriptSearchIndex = null;
		this.transcriptSearchPage = null;
		this.transcriptSearchLoading = false;
		this.transcriptSearchLoadingMore = false;
		this.transcriptSearchPageError = null;
		this.transcriptSearchAnnouncement = '';
		this.transcriptSearchAnnouncementVersion = 0;
		this.transcriptSearchIndexing = false;
		this.transcriptSearchError = null;
		this.transcriptSearchRevalidating = false;
		this.transcriptSearchRevalidationError = null;
		this.transcriptSearchPagePromise = null;
		this.transcriptSearchRevalidationPromise = null;
		this.transcriptSearchRevalidationDirty = false;
		this.clearTranscriptSearchTimers();
		if (candidateIds.length === 0) {
			this.transcriptSearchIndex = {
				indexedChatCount: 0,
				pendingChatCount: 0,
				failedChatCount: 0,
				unindexedChatCount: 0,
				unsupportedChatCount: 0,
				resultsTruncated: false,
			};
			this.transcriptSearchPage = {
				offset: 0,
				limit: TRANSCRIPT_SEARCH_PAGE_SIZE,
				total: 0,
				hasMore: false,
				nextOffset: null,
			};
			unlinkAbort();
			return;
		}

		const waitForRetry = this.deps.waitForTranscriptIndexRetry ?? waitForTranscriptIndexRetry;
		try {
			for (let attempt = 0; attempt < TRANSCRIPT_SEARCH_MAX_ATTEMPTS; attempt += 1) {
				this.transcriptSearchLoading = true;
				this.transcriptSearchIndexing = false;
				let result: ChatSearchResponse;
				try {
					result = await this.searchTranscriptPage({
						query,
						textTokens: spec.textTokens,
						chatIds: candidateIds,
						offset: 0,
						limit: TRANSCRIPT_SEARCH_PAGE_SIZE,
						signal: abort.signal,
					});
				} catch (error) {
					const retryableIndexError = error instanceof ApiError
						&& error.retryable
						&& (error.errorCode === 'SEARCH_INDEX_BUSY'
							|| error.errorCode === 'SEARCH_INDEX_UNAVAILABLE'
							|| error.errorCode === 'SEARCH_TIMEOUT');
					if (!retryableIndexError || attempt === TRANSCRIPT_SEARCH_MAX_ATTEMPTS - 1) throw error;
					this.transcriptSearchLoading = false;
					this.transcriptSearchIndexing = true;
					await waitForRetry(TRANSCRIPT_SEARCH_RETRY_DELAY_MS, abort.signal);
					if (!this.isCurrentTranscriptRequest(requestId, abort.signal)) return;
					continue;
				}
				if (requestId !== this.transcriptSearchRequestId) return;
				if (abort.signal.aborted || !this.deps.getTranscriptSearchEnabled()) {
					this.clearTranscriptSearch();
					return;
				}
				this.transcriptSearchResults = result.results;
				this.transcriptSearchPage = result.page;
				this.transcriptSearchIndex = result.index;
				if (result.index.pendingChatCount === 0
					&& result.index.unindexedChatCount === 0) {
					this.transcriptSearchIndexing = false;
					return;
				}
				this.transcriptSearchLoading = false;
				this.transcriptSearchIndexing = true;
				return;
			}
		} catch (error) {
			if (isAbortError(error) || !this.isCurrentTranscriptRequest(requestId, abort.signal))
				return;
			if (error instanceof ApiError && error.errorCode === 'TRANSCRIPT_SEARCH_DISABLED') {
				this.clearTranscriptSearch();
				return;
			}
			this.transcriptSearchResults = [];
			this.transcriptSearchIndex = null;
			this.transcriptSearchIndexing = false;
			this.transcriptSearchError = m.sidebar_search_transcript_error();
			this.deps.logError?.('Failed to search chat transcripts:', error);
		} finally {
			unlinkAbort();
			if (this.isCurrentTranscriptRequest(requestId, abort.signal)) {
				this.transcriptSearchLoading = false;
				this.scheduleDeferredTranscriptSearchRevalidation();
			}
		}
	}

	loadMoreTranscriptResults(): Promise<void> {
		if (this.transcriptSearchPagePromise) return this.transcriptSearchPagePromise;
		if (!this.canLoadMoreTranscriptResults) return Promise.resolve();
		const nextOffset = this.transcriptSearchPage?.nextOffset;
		if (nextOffset === null || nextOffset === undefined) return Promise.resolve();
		const requestId = this.transcriptSearchRequestId;
		const signal = this.transcriptSearchAbort?.signal;
		const query = this.transcriptSearchQuery;
		const spec = parseChatSearch(query);
		const candidateIds = this.facetFilteredChats(spec).map((chat) => chat.id);
		const highlightedChatId = this.dialogDisplayChats[this.highlightedResultIndex]?.id ?? null;
		const previousVisibleCount = this.dialogDisplayChats.length;
		this.transcriptSearchPageError = null;
		this.transcriptSearchLoadingMore = true;
		const promise = this.searchTranscriptPage({
			query,
			textTokens: spec.textTokens,
			chatIds: candidateIds,
			offset: nextOffset,
			limit: TRANSCRIPT_SEARCH_PAGE_SIZE,
			signal,
		})
			.then((result) => {
				if (!this.isCurrentTranscriptRequest(requestId, signal)) return;
				this.transcriptSearchResults = dedupeSearchResults([
					...this.transcriptSearchResults,
					...result.results,
				]);
				this.transcriptSearchPage = result.page;
				this.transcriptSearchIndex = result.index;
				this.transcriptSearchIndexing = result.index.pendingChatCount > 0
					|| result.index.unindexedChatCount > 0;
				this.restoreHighlightedChat(highlightedChatId);
				const visibleCount = this.dialogDisplayChats.length;
				const added = Math.max(0, visibleCount - previousVisibleCount);
				this.transcriptSearchAnnouncement = added > 0
					? m.sidebar_search_more_chats_shown({ added, total: visibleCount })
					: m.sidebar_search_more_matches_loaded({ total: visibleCount });
				this.transcriptSearchAnnouncementVersion += 1;
			})
			.catch((error) => {
				if (isAbortError(error) || !this.isCurrentTranscriptRequest(requestId, signal)) return;
				this.transcriptSearchPageError = m.sidebar_search_more_error();
				this.deps.logError?.('Failed to load more transcript search results:', error);
			})
			.finally(() => {
				if (this.transcriptSearchPagePromise === promise) {
					this.transcriptSearchPagePromise = null;
				}
				if (this.isCurrentTranscriptRequest(requestId, signal)) {
					this.transcriptSearchLoadingMore = false;
					this.scheduleDeferredTranscriptSearchRevalidation();
				}
			});
		this.transcriptSearchPagePromise = promise;
		return promise;
	}

	scheduleTranscriptSearchRevalidation(): void {
		if (!this.transcriptSearchQuery || !this.transcriptSearchPage) return;
		if (this.transcriptSearchLoading || this.transcriptSearchLoadingMore
			|| this.transcriptSearchRevalidationPromise) {
			this.transcriptSearchRevalidationDirty = true;
			return;
		}
		if (this.transcriptSearchRevalidationTimer) return;
		this.transcriptSearchRevalidationTimer = setTimeout(() => {
			this.transcriptSearchRevalidationTimer = null;
			void this.revalidateTranscriptSearch();
		}, TRANSCRIPT_SEARCH_REVALIDATION_DELAY_MS);
	}

	retryTranscriptSearchRevalidation(): Promise<void> {
		this.transcriptSearchRevalidationError = null;
		return this.revalidateTranscriptSearch();
	}

	private revalidateTranscriptSearch(): Promise<void> {
		if (this.transcriptSearchRevalidationPromise) return this.transcriptSearchRevalidationPromise;
		if (!this.transcriptSearchQuery || !this.transcriptSearchPage) {
			return Promise.resolve();
		}
		if (this.transcriptSearchLoading || this.transcriptSearchLoadingMore) {
			this.transcriptSearchRevalidationDirty = true;
			return Promise.resolve();
		}
		const requestId = this.transcriptSearchRequestId;
		const generationSignal = this.transcriptSearchAbort?.signal;
		const query = this.transcriptSearchQuery;
		const spec = parseChatSearch(query);
		const candidateIds = this.facetFilteredChats(spec).map((chat) => chat.id);
		if (candidateIds.length === 0) return Promise.resolve();
		const sort = this.deps.getSearchResultSort();
		const currentFrontier = this.transcriptSearchPage.nextOffset
			?? this.transcriptSearchPage.total;
		const targetOffset = Math.min(
			TRANSCRIPT_SEARCH_LOADED_LIMIT,
			this.transcriptSearchPage.total === 0
				? this.transcriptSearchPage.limit
				: currentFrontier,
		);
		const highlightedChatId = this.dialogDisplayChats[this.highlightedResultIndex]?.id ?? null;
		const abort = new AbortController();
		const unlinkAbort = forwardAbort(generationSignal, abort);
		const timeout = setTimeout(() => abort.abort(), TRANSCRIPT_SEARCH_REVALIDATION_TIMEOUT_MS);
		this.transcriptSearchRevalidating = true;
		this.transcriptSearchRevalidationError = null;
		const promise = (async () => {
			const refreshed: ChatSearchResult[] = [];
			let nextOffset = 0;
			let latest: ChatSearchResponse | null = null;
			while (nextOffset < targetOffset) {
				const result = await this.searchTranscriptPage({
					query,
					textTokens: spec.textTokens,
					chatIds: candidateIds,
					sort,
					offset: nextOffset,
					limit: Math.min(CHAT_SEARCH_MAX_PAGE_SIZE, targetOffset - nextOffset),
					signal: abort.signal,
				});
				latest = result;
				refreshed.push(...result.results);
				if (!result.page.hasMore || result.page.nextOffset === null) break;
				if (result.page.nextOffset <= nextOffset) throw new Error('Invalid transcript search cursor');
				nextOffset = result.page.nextOffset;
			}
			if (!latest || !this.isCurrentTranscriptRequest(requestId, generationSignal)) return;
			this.transcriptSearchResults = dedupeSearchResults(refreshed);
			this.transcriptSearchPage = latest.page;
			this.transcriptSearchIndex = latest.index;
			this.transcriptSearchIndexing = latest.index.pendingChatCount > 0
				|| latest.index.unindexedChatCount > 0;
			this.restoreHighlightedChat(highlightedChatId);
			this.transcriptSearchRevalidationVersion += 1;
		})()
			.catch((error) => {
				if (!this.isCurrentTranscriptRequest(requestId, generationSignal)) return;
				this.transcriptSearchRevalidationError = m.sidebar_search_update_error();
				if (!isAbortError(error)) this.deps.logError?.('Failed to update transcript search results:', error);
			})
			.finally(() => {
				clearTimeout(timeout);
				unlinkAbort();
				if (this.transcriptSearchRevalidationPromise === promise) {
					this.transcriptSearchRevalidationPromise = null;
				}
				if (this.isCurrentTranscriptRequest(requestId, generationSignal)) {
					this.transcriptSearchRevalidating = false;
					this.scheduleDeferredTranscriptSearchRevalidation();
				}
			});
		this.transcriptSearchRevalidationPromise = promise;
		return promise;
	}

	private searchTranscriptPage(options: TranscriptSearchPageRequest): Promise<ChatSearchResponse> {
		const search = this.deps.searchChatTranscripts ?? searchChatTranscriptsApi;
		return search({
			query: options.query,
			textTokens: options.textTokens,
			chatIds: options.chatIds,
			sort: options.sort ?? this.deps.getSearchResultSort(),
			offset: options.offset,
			limit: options.limit,
		}, { signal: options.signal });
	}

	private scheduleDeferredTranscriptSearchRevalidation(): void {
		if (!this.transcriptSearchRevalidationDirty) return;
		this.transcriptSearchRevalidationDirty = false;
		this.scheduleTranscriptSearchRevalidation();
	}

	private clearTranscriptSearchTimers(): void {
		if (this.transcriptSearchRevalidationTimer) {
			clearTimeout(this.transcriptSearchRevalidationTimer);
		}
		this.transcriptSearchRevalidationTimer = null;
	}

	private cancelTranscriptSearchWork(): void {
		this.clearTranscriptSearchTimers();
		this.transcriptSearchAbort?.abort();
		this.transcriptSearchAbort = null;
		this.transcriptSearchRequestId += 1;
		this.transcriptSearchLoading = false;
		this.transcriptSearchLoadingMore = false;
		this.transcriptSearchPageError = null;
		this.transcriptSearchRevalidating = false;
		this.transcriptSearchRevalidationError = null;
		this.transcriptSearchPagePromise = null;
		this.transcriptSearchRevalidationPromise = null;
		this.transcriptSearchRevalidationDirty = false;
	}

	private isCurrentTranscriptRequest(requestId: number, signal?: AbortSignal): boolean {
		return requestId === this.transcriptSearchRequestId && !signal?.aborted;
	}

	private restoreHighlightedChat(chatId: string | null): void {
		if (!chatId) {
			this.highlightedResultIndex = Math.min(
				this.highlightedResultIndex,
				Math.max(0, this.dialogDisplayChats.length - 1),
			);
			return;
		}
		const index = this.dialogDisplayChats.findIndex((chat) => chat.id === chatId);
		this.highlightedResultIndex = index >= 0
			? index
			: Math.min(this.highlightedResultIndex, Math.max(0, this.dialogDisplayChats.length - 1));
	}

	private restoreEditorOrigin(): void {
		const origin = this.editorOrigin;
		this.editorOrigin = null;
		if (origin === 'manager') {
			this.managerOpen = true;
			return;
		}
		if (origin === 'search-dialog') {
			this.resumeSearchDialog();
		}
	}

	private facetFilteredChats(spec: ChatFilterSpec): ChatSessionRecord[] {
		const facetSpec: ChatFilterSpec = { ...spec, textTokens: [] };
		const chats = this.deps.getChats();
		if (isEmptyFilter(facetSpec)) return chats;
		return chats.filter((chat) => matchesChatFilter(chat, facetSpec));
	}

	private mergeTranscriptMatches(
		query: string,
		metadataMatches: ChatSessionRecord[],
	): ChatSessionRecord[] {
		if (this.transcriptSearchQuery !== query || this.transcriptSearchResults.length === 0) {
			return metadataMatches;
		}
		const chatsById = new Map(this.deps.getChats().map((chat) => [chat.id, chat]));
		const candidateIds = new Set(
			this.facetFilteredChats(parseChatSearch(query)).map((chat) => chat.id),
		);
		const seen = new Set(metadataMatches.map((chat) => chat.id));
		const transcriptOnly = this.transcriptSearchResults
			.map((result) => chatsById.get(result.chatId))
			.filter((chat): chat is ChatSessionRecord => {
				if (!chat) return false;
				return candidateIds.has(chat.id) && !seen.has(chat.id);
			});
		return [...metadataMatches, ...transcriptOnly];
	}

	private createEditorState(query: string): SavedSearchEditorState {
		return {
			mode: 'create',
			title: '',
			query,
			showAsSidebarPill: false,
			showInSidebarMenu: false,
			showInSearchDialog: true,
		};
	}

	private reportActionFailure(logMessage: string, userMessage: string, error: unknown): void {
		this.deps.logError?.(logMessage, error);
		this.deps.notifyError(userMessage);
	}
}

export function transcriptSearchCandidateSignature(
	chats: ChatSessionRecord[],
	query: string,
): string {
	return JSON.stringify(candidateChatsForSearch(chats, query).map((chat) => chat.id).sort());
}

export function transcriptSearchContentRevisionSignature(
	chats: ChatSessionRecord[],
	query: string,
): string {
	return JSON.stringify(
		candidateChatsForSearch(chats, query)
			.map((chat) => [chat.id, chat.lastActivityAt] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}

export function transcriptSearchTimeOrderSignature(
	chats: ChatSessionRecord[],
	query: string,
	sort: ChatSearchSort,
): string {
	if (sort === 'relevance') return '';
	const compareTime = compareChatOrderNewestFirst(sort);
	return JSON.stringify(
		candidateChatsForSearch(chats, query)
			.sort((left, right) => compareTime(left, right) || left.id.localeCompare(right.id))
			.map((chat) => chat.id),
	);
}

function candidateChatsForSearch(
	chats: ChatSessionRecord[],
	query: string,
): ChatSessionRecord[] {
	const spec = { ...parseChatSearch(query), textTokens: [] };
	return isEmptyFilter(spec) ? [...chats] : chats.filter((chat) => matchesChatFilter(chat, spec));
}

function dedupeSearchResults(results: readonly ChatSearchResult[]): ChatSearchResult[] {
	const seen = new Set<string>();
	return results.filter((result) => {
		if (seen.has(result.chatId)) return false;
		seen.add(result.chatId);
		return true;
	});
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	const abort = () => target.abort();
	source.addEventListener('abort', abort, { once: true });
	if (source.aborted) abort();
	return () => source.removeEventListener('abort', abort);
}

function waitForTranscriptIndexRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abortError = () => new DOMException('Search aborted', 'AbortError');
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const handleAbort = () => {
			clearTimeout(timeoutId);
			reject(abortError());
		};
		const timeoutId = setTimeout(() => {
			signal?.removeEventListener('abort', handleAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener('abort', handleAbort, { once: true });
	});
}

export function createSidebarSearchStore(deps: SidebarSearchStoreDeps): SidebarSearchStore {
	return new SidebarSearchStore(deps);
}

function searchExists(search: SavedChatSearch | undefined): search is SavedChatSearch {
	return Boolean(search);
}
