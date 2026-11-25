// App-session sidebar search state. Owns active filtering, search dialog state,
// and saved-search CRUD so mobile drawer remounts do not reset search context.

import type { SavedChatSearch } from '$lib/api/settings';
import {
	isEmptyFilter,
	matchesChatFilter,
	parseChatSearch,
	type ChatFilterSpec,
} from '$shared/chat-filter-query';
import type { ChatSessionRecord } from '$lib/chat/sessions/chat-session-types';
import {
	sortChatSearchResultsWithCommittedTimeOrder,
	visibleChatSearchTimePrefix,
} from '$lib/sidebar/search/search-result-order.js';
import { mergeTranscriptMatches } from './transcript-search-merge.js';
import type { TranscriptSearchStatusV1 } from '$shared/chat-search';
import {
	TranscriptSearchController,
	type TranscriptSearchDeps,
} from './transcript-search-controller.svelte.js';
import {
	SavedSearchesStore,
	type SavedSearchInput,
	type SavedSearchesDeps,
} from './saved-searches-store.svelte.js';
export type { SavedSearchInput } from './saved-searches-store.svelte.js';

export interface SavedSearchEditorState {
	mode: 'create' | 'edit';
	searchId?: string;
	title: string;
	query: string;
	showAsSidebarPill: boolean;
	showInSidebarMenu: boolean;
	showInSearchDialog: boolean;
}

type SavedSearchDialogOrigin = 'manager' | 'search-dialog';

export interface SidebarSearchStoreDeps extends TranscriptSearchDeps, SavedSearchesDeps {
	getSelectedChatId: () => string | null;
}

export class SidebarSearchStore {
	activeQuery = $state('');
	draftQuery = $state('');
	searchDialogOpen = $state(false);
	highlightedResultIndex = $state(0);

	managerOpen = $state(false);
	editorState = $state<SavedSearchEditorState | null>(null);
	deleteConfirmation = $state<{ id: string } | null>(null);

	private managerOrigin: 'search-dialog' | null = null;
	private editorOrigin: SavedSearchDialogOrigin | null = null;
	#parsedQuery = $derived(parseChatSearch(this.activeQuery));
	#parsedDraftQuery = $derived(parseChatSearch(this.draftQuery));
	#filteredChats = $derived.by(() => {
		const chats = this.deps.getChats();
		const metadataMatches = isEmptyFilter(this.#parsedQuery)
			? chats
			: chats.filter((chat) => matchesChatFilter(chat, this.#parsedQuery));
		return mergeTranscriptMatches(this.activeQuery, metadataMatches, chats, {
			query: this.transcript.transcriptSearchQuery,
			results: this.transcript.transcriptSearchResults,
		});
	});
	#dialogFilteredChats = $derived.by(() => {
		const chats = this.deps.getChats();
		if (isEmptyFilter(this.#parsedDraftQuery)) return chats;
		return chats.filter((chat) => matchesChatFilter(chat, this.#parsedDraftQuery));
	});
	#dialogDisplayChats = $derived.by(() => {
		const sort = this.deps.getSearchResultSort();
		const merged = mergeTranscriptMatches(
			this.draftQuery,
			this.#dialogFilteredChats,
			this.deps.getChats(),
			{
				query: this.transcript.transcriptSearchQuery,
				results: this.transcript.transcriptSearchResults,
			},
		);
		const sorted = sortChatSearchResultsWithCommittedTimeOrder(
			merged,
			sort,
			this.transcript.transcriptSearchCommittedTimeOrder,
		);
		if (sort === 'relevance' || this.transcript.transcriptSearchQuery !== this.draftQuery)
			return sorted;
		return visibleChatSearchTimePrefix(
			sorted,
			new Set(this.transcript.transcriptSearchResults.map((result) => result.chatId)),
			this.transcript.transcriptSearchPage?.hasMore === true &&
				!this.transcript.transcriptSearchLimitReached,
		);
	});

	readonly transcript: TranscriptSearchController;
	private readonly saved: SavedSearchesStore;

	constructor(private readonly deps: SidebarSearchStoreDeps) {
		this.saved = new SavedSearchesStore(deps);
		this.transcript = new TranscriptSearchController({
			...deps,
			getDraftQuery: () => this.draftQuery,
			getDisplayChats: () => this.dialogDisplayChats,
			getHighlightedIndex: () => this.highlightedResultIndex,
			setHighlightedIndex: (index) => (this.highlightedResultIndex = index),
		});
	}

	applyTranscriptSearchStatus(status: TranscriptSearchStatusV1): void {
		this.transcript.applyTranscriptSearchStatus(status);
	}

	destroy(): void {
		this.transcript.destroy();
	}

	get parsedQuery(): ChatFilterSpec {
		return this.#parsedQuery;
	}

	get parsedDraftQuery(): ChatFilterSpec {
		return this.#parsedDraftQuery;
	}

	get filteredChats(): ChatSessionRecord[] {
		return this.#filteredChats;
	}

	get dialogFilteredChats(): ChatSessionRecord[] {
		return this.#dialogFilteredChats;
	}

	get dialogDisplayChats(): ChatSessionRecord[] {
		return this.#dialogDisplayChats;
	}

	get isFiltered(): boolean {
		return this.hasActiveQuery;
	}

	hasActiveQuery = $derived(this.activeQuery.trim().length > 0);
	allKnownTags = $derived.by(() =>
		Array.from(new Set(this.deps.getChats().flatMap((chat) => chat.tags))).sort(),
	);

	get initialHighlightedResultIndex(): number {
		const selectedChatId = this.deps.getSelectedChatId();
		if (!selectedChatId) return 0;

		const selectedIndex = this.dialogDisplayChats.findIndex((chat) => chat.id === selectedChatId);
		return selectedIndex >= 0 ? selectedIndex : 0;
	}

	get savedSearches() {
		return this.saved.searches;
	}
	get savedSearchesLoaded() {
		return this.saved.loaded;
	}
	get savedSearchesLoading() {
		return this.saved.loading;
	}
	get sidebarPillSearches() {
		return this.saved.sidebarPillSearches;
	}
	get sidebarMenuSearches() {
		return this.saved.sidebarMenuSearches;
	}
	get searchDialogSavedSearches() {
		return this.saved.searchDialogSavedSearches;
	}

	setSavedSearches(searches: SavedChatSearch[]): void {
		this.saved.setSavedSearches(searches);
	}

	loadSavedSearches(): Promise<void> {
		return this.saved.loadSavedSearches();
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
		if (this.transcript.transcriptSearchQuery !== this.activeQuery)
			this.transcript.cancelTranscriptSearchWork();
		this.searchDialogOpen = false;
		this.draftQuery = this.activeQuery;
		this.highlightedResultIndex = 0;
	}

	suspendSearchDialog(): void {
		this.searchDialogOpen = false;
		this.highlightedResultIndex = 0;
	}

	// Clears every search dialog state without the suspend/resume origin
	// paths, so a dialog cluster that outlived a mobile drawer remount can
	// never reopen. Applied filters (activeQuery) survive.
	resetDialogs(): void {
		this.managerOrigin = null;
		this.editorOrigin = null;
		this.editorState = null;
		this.managerOpen = false;
		this.deleteConfirmation = null;
		this.searchDialogOpen = false;
		this.draftQuery = this.activeQuery;
		this.highlightedResultIndex = 0;
	}

	resumeSearchDialog(): void {
		this.searchDialogOpen = true;
		this.highlightedResultIndex = this.initialHighlightedResultIndex;
	}

	applyQuery(query: string): void {
		if (query !== this.activeQuery) this.transcript.clearTranscriptSearch();
		this.activeQuery = query;
		this.highlightedResultIndex = 0;
	}

	updateDraftQuery(query: string): void {
		if (query !== this.draftQuery) {
			this.transcript.transcriptSearchResultsResetVersion += 1;
			this.transcript.clearTranscriptSearch();
		}
		this.draftQuery = query;
		this.highlightedResultIndex = 0;
	}

	resetTranscriptSearchForSortChange(): void {
		this.highlightedResultIndex = 0;
		this.transcript.transcriptSearchResultsResetVersion += 1;
		this.transcript.clearTranscriptSearch();
	}

	confirmSearchDialog(): void {
		this.activeQuery = this.draftQuery;
		if (this.transcript.transcriptSearchQuery !== this.activeQuery)
			this.transcript.cancelTranscriptSearchWork();
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
		await this.saved.save(data, searchId);
		this.closeEditor();
	}

	requestDelete(id: string): void {
		this.deleteConfirmation = { id };
	}

	clearDeleteConfirmation(): void {
		this.deleteConfirmation = null;
	}

	async confirmDelete(): Promise<void> {
		const confirmation = this.deleteConfirmation;
		if (!confirmation) return;
		this.deleteConfirmation = null;
		await this.saved.delete(confirmation.id);
	}

	reorder(oldOrder: string[], newOrder: string[]): Promise<void> {
		return this.saved.reorder(oldOrder, newOrder);
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
}

export function createSidebarSearchStore(deps: SidebarSearchStoreDeps): SidebarSearchStore {
	return new SidebarSearchStore(deps);
}
