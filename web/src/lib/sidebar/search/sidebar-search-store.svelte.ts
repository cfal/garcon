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
import { searchChatTranscripts as searchChatTranscriptsApi } from '$lib/api/chats';
import {
	isEmptyFilter,
	matchesChatFilter,
	parseChatSearch,
	type ChatFilterSpec,
} from '$lib/sidebar/search/sidebar-search.js';
import type { ChatSessionRecord } from '$lib/types/chat-session';
import * as m from '$lib/paraglide/messages.js';
import type {
	ChatSearchIndexStatus,
	ChatSearchRequest,
	ChatSearchResult,
	ChatSearchResponse,
} from '$shared/chat-search';

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
}

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
	transcriptSearchError = $state<string | null>(null);

	private managerOrigin = $state<'search-dialog' | null>(null);
	private editorOrigin = $state<SavedSearchDialogOrigin | null>(null);
	private loadPromise: Promise<void> | null = null;

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
		return this.mergeTranscriptMatches(this.draftQuery, this.dialogFilteredChats);
	}

	get transcriptSearchResultsByChatId(): Map<string, ChatSearchResult> {
		return new Map(this.transcriptSearchResults.map((result) => [result.chatId, result]));
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

		const selectedIndex = this.dialogFilteredChats.findIndex((chat) => chat.id === selectedChatId);
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
		this.draftQuery = query;
		this.highlightedResultIndex = 0;
	}

	confirmSearchDialog(): void {
		this.activeQuery = this.draftQuery;
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
		this.transcriptSearchQuery = '';
		this.transcriptSearchResults = [];
		this.transcriptSearchIndex = null;
		this.transcriptSearchLoading = false;
		this.transcriptSearchError = null;
	}

	async refreshTranscriptSearch(
		query: string,
		options: { signal?: AbortSignal } = {},
	): Promise<void> {
		const spec = parseChatSearch(query);
		if (spec.textTokens.length === 0) {
			this.clearTranscriptSearch();
			return;
		}

		const candidateChats = this.facetFilteredChats(spec);
		const candidateIds = candidateChats.map((chat) => chat.id);
		const searchChatTranscripts = this.deps.searchChatTranscripts ?? searchChatTranscriptsApi;
		if (this.transcriptSearchQuery !== query) {
			this.transcriptSearchResults = [];
			this.transcriptSearchIndex = null;
		}
		this.transcriptSearchQuery = query;
		this.transcriptSearchLoading = true;
		this.transcriptSearchError = null;
		try {
			const result = await searchChatTranscripts(
				{
					query,
					textTokens: spec.textTokens,
					chatIds: candidateIds,
					limit: 50,
				},
				{ signal: options.signal },
			);
			if (options.signal?.aborted || this.transcriptSearchQuery !== query) return;
			this.transcriptSearchResults = result.results;
			this.transcriptSearchIndex = result.index;
		} catch (error) {
			if (options.signal?.aborted) return;
			this.transcriptSearchResults = [];
			this.transcriptSearchIndex = null;
			this.transcriptSearchError = error instanceof Error ? error.message : String(error);
			this.deps.logError?.('Failed to search chat transcripts:', error);
		} finally {
			if (!options.signal?.aborted && this.transcriptSearchQuery === query) {
				this.transcriptSearchLoading = false;
			}
		}
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
		const seen = new Set(metadataMatches.map((chat) => chat.id));
		const transcriptOnly = this.transcriptSearchResults
			.map((result) => chatsById.get(result.chatId))
			.filter((chat): chat is ChatSessionRecord => {
				if (!chat) return false;
				return !seen.has(chat.id);
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

export function createSidebarSearchStore(deps: SidebarSearchStoreDeps): SidebarSearchStore {
	return new SidebarSearchStore(deps);
}

function searchExists(search: SavedChatSearch | undefined): search is SavedChatSearch {
	return Boolean(search);
}
