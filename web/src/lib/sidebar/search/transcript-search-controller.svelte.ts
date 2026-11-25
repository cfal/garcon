import { searchChatTranscripts as searchChatTranscriptsApi } from '$lib/api/chats';
import { ApiError } from '$lib/api/client';
import { parseChatSearch } from '$shared/chat-filter-query';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import type { TranscriptRowTarget } from '$lib/chat/transcript/transcript-row-navigation.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import * as m from '$lib/paraglide/messages.js';
import { captureChatSearchTimeOrder } from './search-result-order.js';
import {
	dedupeSearchResults,
	forwardAbort,
	isTranscriptSearchIndexPartial,
	waitForTranscriptIndexRetry,
} from './transcript-search-request.js';
import { facetFilteredChats } from './transcript-search-merge.js';
import type {
	ChatSearchIndexStatus,
	ChatSearchPage,
	ChatSearchRequest,
	ChatSearchResult,
	ChatSearchResultMode,
	ChatSearchResponse,
	ChatSearchSort,
	TranscriptSearchStatusV1,
} from '$shared/chat-search';

export interface TranscriptSearchDeps {
	getChats: () => ChatSessionRecord[];
	getTranscriptSearchEnabled: () => boolean;
	getSearchResultSort: () => ChatSearchSort;
	logError?: (message: string, error: unknown) => void;
	searchChatTranscripts?: (
		request: ChatSearchRequest,
		options?: { signal?: AbortSignal },
	) => Promise<ChatSearchResponse>;
	waitForTranscriptIndexRetry?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface TranscriptSearchResultSelectionPort {
	getDraftQuery(): string;
	getDisplayChats(): ChatSessionRecord[];
	getHighlightedIndex(): number;
	setHighlightedIndex(index: number): void;
}

interface TranscriptSearchPageRequest {
	query: string;
	textTokens: string[];
	chatIds: string[];
	sort?: ChatSearchSort;
	mode: ChatSearchResultMode;
	offset: number;
	limit: number;
	snippetLimit: number;
	signal?: AbortSignal;
}

const TRANSCRIPT_SEARCH_MAX_ATTEMPTS = 2;
const TRANSCRIPT_SEARCH_RETRY_DELAY_MS = 1_000;
const TRANSCRIPT_SEARCH_INITIAL_PAGE_SIZE = 50;
const TRANSCRIPT_SEARCH_CONTINUATION_PAGE_SIZE = 100;
const TRANSCRIPT_SEARCH_LOADED_LIMIT = 500;
const TRANSCRIPT_SEARCH_SNIPPET_LIMIT = 1;
const TRANSCRIPT_SEARCH_REVALIDATION_DELAY_MS = 500;
const TRANSCRIPT_SEARCH_REVALIDATION_MIN_INTERVAL_MS = 1_000;
const TRANSCRIPT_SEARCH_REVALIDATION_TIMEOUT_MS = 5_000;

type TranscriptSearchOperation = 'initial' | 'append' | 'revalidate';

export class TranscriptSearchController {
	transcriptSearchQuery = $state('');
	transcriptSearchResults = $state.raw<ChatSearchResult[]>([]);
	transcriptSearchIndex = $state.raw<ChatSearchIndexStatus | null>(null);
	transcriptSearchLoading = $state(false);
	transcriptSearchIndexing = $state(false);
	transcriptSearchError = $state<string | null>(null);
	transcriptSearchStatus = $state.raw<TranscriptSearchStatusV1 | null>(null);
	transcriptSearchPage = $state.raw<ChatSearchPage | null>(null);
	transcriptSearchLoadingMore = $state(false);
	transcriptSearchPageError = $state<string | null>(null);
	transcriptSearchAnnouncement = $state('');
	transcriptSearchAnnouncementVersion = $state(0);
	transcriptSearchResultsResetVersion = $state(0);
	transcriptSearchRevalidating = $state(false);
	transcriptSearchRevalidationError = $state<string | null>(null);
	transcriptSearchRevalidationVersion = $state(0);

	private transcriptSearchRequestId = 0;
	private transcriptSearchAbort: AbortController | null = null;
	private transcriptSearchPagePromise: Promise<void> | null = null;
	private transcriptSearchRevalidationPromise: Promise<void> | null = null;
	private transcriptSearchRevalidationTimer: ReturnType<typeof setTimeout> | null = null;
	private transcriptSearchContentDirty = false;
	private transcriptSearchPendingIndexCatchUp = false;
	private transcriptSearchOperation: TranscriptSearchOperation | null = null;
	private lastTranscriptSearchRevalidationStartedAt = Number.NEGATIVE_INFINITY;
	transcriptSearchCommittedTimeOrder = $state.raw<string[] | null>(null);
	private observedTranscriptSearchCandidateSignature: string | null = null;
	#transcriptSearchResultsByChatId = $derived(
		new Map(this.transcriptSearchResults.map((result) => [result.chatId, result])),
	);

	constructor(private readonly deps: TranscriptSearchDeps & TranscriptSearchResultSelectionPort) {}

	get transcriptSearchResultsByChatId(): Map<string, ChatSearchResult> {
		return this.#transcriptSearchResultsByChatId;
	}

	get canLoadMoreTranscriptResults(): boolean {
		const nextOffset = this.transcriptSearchPage?.nextOffset;
		return (
			this.transcriptSearchQuery === this.deps.getDraftQuery() &&
			this.transcriptSearchPage?.hasMore === true &&
			nextOffset !== null &&
			nextOffset !== undefined &&
			nextOffset < TRANSCRIPT_SEARCH_LOADED_LIMIT &&
			!this.transcriptSearchLoading &&
			!this.transcriptSearchLoadingMore &&
			!this.transcriptSearchRevalidating &&
			!this.transcriptSearchRevalidationError
		);
	}

	get transcriptSearchLimitReached(): boolean {
		const nextOffset = this.transcriptSearchPage?.nextOffset;
		return (
			this.transcriptSearchPage?.hasMore === true &&
			nextOffset !== null &&
			nextOffset !== undefined &&
			nextOffset >= TRANSCRIPT_SEARCH_LOADED_LIMIT
		);
	}

	transcriptResultTarget(chatId: string): TranscriptRowTarget | null {
		const result = this.transcriptSearchResultsByChatId.get(chatId);
		const snippet = result?.snippets[0];
		return result && snippet
			? { chatId, transcriptViewId: result.transcriptViewId, ordinal: snippet.ordinal }
			: null;
	}

	discardStaleTranscriptResult(target: TranscriptRowTarget): void {
		const result = this.transcriptSearchResultsByChatId.get(target.chatId);
		if (result?.transcriptViewId !== target.transcriptViewId) return;
		this.transcriptSearchResults = this.transcriptSearchResults.filter((entry) => entry !== result);
		void this.refreshTranscriptSearch(this.transcriptSearchQuery);
	}

	updateTranscriptSearchCandidateSignature(signature: string): void {
		const previousSignature = this.observedTranscriptSearchCandidateSignature;
		this.observedTranscriptSearchCandidateSignature = signature;
		if (previousSignature !== null && previousSignature !== signature) {
			this.clearTranscriptSearch();
		}
	}

	clearTranscriptSearch(): void {
		this.cancelTranscriptSearchWork();
		this.resetTranscriptSearchResults('');
	}

	private resetTranscriptSearchResults(query: string): void {
		this.transcriptSearchQuery = query;
		this.transcriptSearchResults = [];
		this.transcriptSearchIndex = null;
		this.transcriptSearchPage = null;
		this.transcriptSearchAnnouncement = '';
		this.transcriptSearchAnnouncementVersion = 0;
		this.transcriptSearchCommittedTimeOrder = null;
		this.transcriptSearchIndexing = false;
		this.transcriptSearchError = null;
	}

	applyTranscriptSearchStatus(status: TranscriptSearchStatusV1): void {
		const previousStatus = this.transcriptSearchStatus;
		this.transcriptSearchStatus = status;
		if (!this.transcriptSearchQuery) return;
		const searchIndexChanged =
			previousStatus?.phase !== status.phase ||
			status.chats.indexed > (previousStatus?.chats.indexed ?? -1);
		if (!searchIndexChanged) return;
		if (this.transcriptSearchOperation || this.transcriptSearchIndexing) {
			this.scheduleTranscriptSearchRevalidation('index');
		}
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

		const candidateChats = facetFilteredChats(spec, this.deps.getChats());
		const candidateIds = candidateChats.map((chat) => chat.id);
		const sort = this.deps.getSearchResultSort();
		const committedTimeOrder = captureChatSearchTimeOrder(candidateChats, sort);
		this.cancelTranscriptSearchWork();
		const abort = new AbortController();
		this.transcriptSearchAbort = abort;
		const unlinkAbort = forwardAbort(options.signal, abort);
		const requestId = this.transcriptSearchRequestId;
		this.resetTranscriptSearchResults(query);
		if (candidateIds.length === 0) {
			this.transcriptSearchIndex = {
				indexedChatCount: 0,
				pendingChatCount: 0,
				failedChatCount: 0,
				unindexedChatCount: 0,
				unsupportedChatCount: 0,
				resultsTruncated: false,
				failedChats: [],
				failedChatsOmittedCount: 0,
			};
			this.transcriptSearchPage = {
				offset: 0,
				limit: TRANSCRIPT_SEARCH_INITIAL_PAGE_SIZE,
				total: 0,
				hasMore: false,
				nextOffset: null,
			};
			unlinkAbort();
			return;
		}

		this.transcriptSearchOperation = 'initial';
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
						sort,
						mode: 'page',
						offset: 0,
						limit: TRANSCRIPT_SEARCH_INITIAL_PAGE_SIZE,
						snippetLimit: TRANSCRIPT_SEARCH_SNIPPET_LIMIT,
						signal: abort.signal,
					});
				} catch (error) {
					const retryableIndexError =
						error instanceof ApiError &&
						error.retryable &&
						(error.errorCode === 'SEARCH_INDEX_BUSY' ||
							error.errorCode === 'SEARCH_INDEX_UNAVAILABLE' ||
							error.errorCode === 'SEARCH_TIMEOUT');
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
				this.transcriptSearchCommittedTimeOrder = committedTimeOrder;
				this.transcriptSearchResults = result.results;
				this.transcriptSearchPage = result.page;
				this.transcriptSearchIndex = result.index;
				const responseIsPartial = isTranscriptSearchIndexPartial(result.index);
				this.transcriptSearchIndexing = responseIsPartial;
				if (!responseIsPartial) {
					this.transcriptSearchPendingIndexCatchUp = false;
					return;
				}
				this.transcriptSearchLoading = false;
				return;
			}
		} catch (error) {
			if (isAbortError(error) || !this.isCurrentTranscriptRequest(requestId, abort.signal)) return;
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
				if (this.transcriptSearchOperation === 'initial') {
					this.transcriptSearchOperation = null;
				}
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
		const candidateIds = facetFilteredChats(spec, this.deps.getChats()).map((chat) => chat.id);
		this.transcriptSearchPageError = null;
		this.transcriptSearchLoadingMore = true;
		this.transcriptSearchOperation = 'append';
		const promise = this.searchTranscriptPage({
			query,
			textTokens: spec.textTokens,
			chatIds: candidateIds,
			mode: 'page',
			offset: nextOffset,
			limit: Math.min(
				TRANSCRIPT_SEARCH_CONTINUATION_PAGE_SIZE,
				TRANSCRIPT_SEARCH_LOADED_LIMIT - nextOffset,
			),
			snippetLimit: TRANSCRIPT_SEARCH_SNIPPET_LIMIT,
			signal,
		})
			.then((result) => {
				if (!this.isCurrentTranscriptRequest(requestId, signal)) return;
				const highlightedChatId =
					this.deps.getDisplayChats()[this.deps.getHighlightedIndex()]?.id ?? null;
				const previousVisibleCount = this.deps.getDisplayChats().length;
				this.transcriptSearchResults = dedupeSearchResults([
					...this.transcriptSearchResults,
					...result.results,
				]).slice(0, TRANSCRIPT_SEARCH_LOADED_LIMIT);
				this.transcriptSearchPage = result.page;
				this.transcriptSearchIndex = result.index;
				this.transcriptSearchIndexing =
					this.transcriptSearchIndexing || isTranscriptSearchIndexPartial(result.index);
				if (!this.transcriptSearchIndexing) {
					this.transcriptSearchPendingIndexCatchUp = false;
				}
				this.restoreHighlightedChat(highlightedChatId);
				const visibleCount = this.deps.getDisplayChats().length;
				const added = Math.max(0, visibleCount - previousVisibleCount);
				this.transcriptSearchAnnouncement =
					added > 0
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
					if (this.transcriptSearchOperation === 'append') {
						this.transcriptSearchOperation = null;
					}
					this.scheduleDeferredTranscriptSearchRevalidation();
				}
			});
		this.transcriptSearchPagePromise = promise;
		return promise;
	}

	scheduleTranscriptSearchRevalidation(reason: 'content' | 'index' = 'content'): void {
		if (!this.transcriptSearchQuery) return;
		if (reason === 'content') this.transcriptSearchContentDirty = true;
		else this.transcriptSearchPendingIndexCatchUp = true;
		this.scheduleDeferredTranscriptSearchRevalidation();
	}

	retryTranscriptSearchRevalidation(): Promise<void> {
		this.clearTranscriptSearchTimers();
		this.transcriptSearchRevalidationError = null;
		if (!this.transcriptSearchContentDirty && !this.transcriptSearchPendingIndexCatchUp) {
			this.transcriptSearchContentDirty = true;
		}
		return this.revalidateTranscriptSearch();
	}

	private revalidateTranscriptSearch(): Promise<void> {
		if (this.transcriptSearchRevalidationPromise) return this.transcriptSearchRevalidationPromise;
		if (this.transcriptSearchRevalidationError) return Promise.resolve();
		if (!this.transcriptSearchQuery || !this.transcriptSearchPage) {
			return Promise.resolve();
		}
		if (this.transcriptSearchOperation) return Promise.resolve();
		const requestId = this.transcriptSearchRequestId;
		const generationSignal = this.transcriptSearchAbort?.signal;
		const query = this.transcriptSearchQuery;
		const spec = parseChatSearch(query);
		const candidateChats = facetFilteredChats(spec, this.deps.getChats());
		const candidateIds = candidateChats.map((chat) => chat.id);
		if (candidateIds.length === 0) return Promise.resolve();
		const sort = this.deps.getSearchResultSort();
		const committedTimeOrder = captureChatSearchTimeOrder(candidateChats, sort);
		const currentFrontier = this.transcriptSearchPage.nextOffset ?? this.transcriptSearchPage.total;
		const targetOffset = Math.min(
			TRANSCRIPT_SEARCH_LOADED_LIMIT,
			this.transcriptSearchPage.total === 0 ? this.transcriptSearchPage.limit : currentFrontier,
		);
		const abort = new AbortController();
		const unlinkAbort = forwardAbort(generationSignal, abort);
		const timeout = setTimeout(() => abort.abort(), TRANSCRIPT_SEARCH_REVALIDATION_TIMEOUT_MS);
		const consumedContentDirty = this.transcriptSearchContentDirty;
		const consumedIndexCatchUp = this.transcriptSearchPendingIndexCatchUp;
		this.transcriptSearchContentDirty = false;
		this.transcriptSearchPendingIndexCatchUp = false;
		this.transcriptSearchOperation = 'revalidate';
		this.lastTranscriptSearchRevalidationStartedAt = performance.now();
		this.transcriptSearchRevalidating = true;
		this.transcriptSearchRevalidationError = null;
		const promise = this.searchTranscriptPage({
			query,
			textTokens: spec.textTokens,
			chatIds: candidateIds,
			sort,
			mode: 'prefix',
			offset: 0,
			limit: targetOffset,
			snippetLimit: TRANSCRIPT_SEARCH_SNIPPET_LIMIT,
			signal: abort.signal,
		})
			.then((result) => {
				if (!this.isCurrentTranscriptRequest(requestId, generationSignal)) return;
				const highlightedChatId =
					this.deps.getDisplayChats()[this.deps.getHighlightedIndex()]?.id ?? null;
				this.transcriptSearchCommittedTimeOrder = committedTimeOrder;
				this.transcriptSearchResults = dedupeSearchResults(result.results);
				this.transcriptSearchPage = result.page;
				this.transcriptSearchPageError = null;
				this.transcriptSearchIndex = result.index;
				this.transcriptSearchIndexing = isTranscriptSearchIndexPartial(result.index);
				if (!this.transcriptSearchIndexing) {
					this.transcriptSearchPendingIndexCatchUp = false;
				}
				this.restoreHighlightedChat(highlightedChatId);
				this.transcriptSearchRevalidationVersion += 1;
			})
			.catch((error) => {
				if (!this.isCurrentTranscriptRequest(requestId, generationSignal)) return;
				this.transcriptSearchContentDirty =
					this.transcriptSearchContentDirty || consumedContentDirty;
				this.transcriptSearchPendingIndexCatchUp =
					this.transcriptSearchPendingIndexCatchUp || consumedIndexCatchUp;
				this.transcriptSearchRevalidationError = m.sidebar_search_update_error();
				if (!isAbortError(error))
					this.deps.logError?.('Failed to update transcript search results:', error);
			})
			.finally(() => {
				clearTimeout(timeout);
				unlinkAbort();
				if (this.transcriptSearchRevalidationPromise === promise) {
					this.transcriptSearchRevalidationPromise = null;
				}
				if (this.isCurrentTranscriptRequest(requestId, generationSignal)) {
					this.transcriptSearchRevalidating = false;
					if (this.transcriptSearchOperation === 'revalidate') {
						this.transcriptSearchOperation = null;
					}
					this.scheduleDeferredTranscriptSearchRevalidation();
				}
			});
		this.transcriptSearchRevalidationPromise = promise;
		return promise;
	}

	private searchTranscriptPage(options: TranscriptSearchPageRequest): Promise<ChatSearchResponse> {
		const search = this.deps.searchChatTranscripts ?? searchChatTranscriptsApi;
		return search(
			{
				query: options.query,
				textTokens: options.textTokens,
				chatIds: options.chatIds,
				sort: options.sort ?? this.deps.getSearchResultSort(),
				mode: options.mode,
				offset: options.offset,
				limit: options.limit,
				snippetLimit: options.snippetLimit,
			},
			{ signal: options.signal },
		);
	}

	private scheduleDeferredTranscriptSearchRevalidation(): void {
		if (
			this.transcriptSearchOperation ||
			this.transcriptSearchRevalidationError ||
			!this.transcriptSearchQuery ||
			!this.transcriptSearchPage
		)
			return;
		if (this.transcriptSearchPendingIndexCatchUp && !this.transcriptSearchIndexing) {
			this.transcriptSearchPendingIndexCatchUp = false;
		}
		if (!this.transcriptSearchContentDirty && !this.transcriptSearchPendingIndexCatchUp) return;
		if (this.transcriptSearchRevalidationTimer) return;
		const cadenceDelay =
			this.lastTranscriptSearchRevalidationStartedAt +
			TRANSCRIPT_SEARCH_REVALIDATION_MIN_INTERVAL_MS -
			performance.now();
		const delay = Math.max(TRANSCRIPT_SEARCH_REVALIDATION_DELAY_MS, cadenceDelay);
		this.transcriptSearchRevalidationTimer = setTimeout(() => {
			this.transcriptSearchRevalidationTimer = null;
			void this.revalidateTranscriptSearch();
		}, delay);
	}

	private clearTranscriptSearchTimers(): void {
		if (this.transcriptSearchRevalidationTimer) {
			clearTimeout(this.transcriptSearchRevalidationTimer);
		}
		this.transcriptSearchRevalidationTimer = null;
	}

	cancelTranscriptSearchWork(): void {
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
		this.transcriptSearchContentDirty = false;
		this.transcriptSearchPendingIndexCatchUp = false;
		this.transcriptSearchOperation = null;
		this.lastTranscriptSearchRevalidationStartedAt = Number.NEGATIVE_INFINITY;
	}

	private isCurrentTranscriptRequest(requestId: number, signal?: AbortSignal): boolean {
		return requestId === this.transcriptSearchRequestId && !signal?.aborted;
	}

	private restoreHighlightedChat(chatId: string | null): void {
		if (!chatId) {
			this.deps.setHighlightedIndex(
				Math.min(
					this.deps.getHighlightedIndex(),
					Math.max(0, this.deps.getDisplayChats().length - 1),
				),
			);
			return;
		}
		const index = this.deps.getDisplayChats().findIndex((chat) => chat.id === chatId);
		this.deps.setHighlightedIndex(
			index >= 0
				? index
				: Math.min(
						this.deps.getHighlightedIndex(),
						Math.max(0, this.deps.getDisplayChats().length - 1),
					),
		);
	}
}
