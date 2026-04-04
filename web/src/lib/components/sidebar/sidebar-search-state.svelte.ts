// Query-oriented sidebar search state. Replaces the folder-based
// SidebarFilterState with a single active-query model, loaded saved
// searches, dialog state, and CRUD coordination.

import type { ChatSessionRecord } from '$lib/types/chat-session';
import type { SavedChatSearch } from '$lib/api/settings';
import { parseChatSearch, isEmptyFilter, matchesChatFilter, type ChatFilterSpec } from './sidebar-search';

export class SidebarSearchState {
	activeQuery = $state('');
	draftQuery = $state('');
	savedSearches = $state<SavedChatSearch[]>([]);
	searchDialogOpen = $state(false);
	manageSavedSearchesOpen = $state(false);
	highlightedResultIndex = $state(0);

	#getChats: () => ChatSessionRecord[];

	constructor(deps: { get chats(): ChatSessionRecord[] }) {
		this.#getChats = () => deps.chats;
	}

	get parsedQuery(): ChatFilterSpec {
		return parseChatSearch(this.activeQuery);
	}

	get parsedDraftQuery(): ChatFilterSpec {
		return parseChatSearch(this.draftQuery);
	}

	get filteredChats(): ChatSessionRecord[] {
		const filter = this.parsedQuery;
		const chats = this.#getChats();
		if (isEmptyFilter(filter)) return chats;
		return chats.filter((chat) => matchesChatFilter(chat, filter));
	}

	get dialogFilteredChats(): ChatSessionRecord[] {
		const filter = this.parsedDraftQuery;
		const chats = this.#getChats();
		if (isEmptyFilter(filter)) return chats;
		return chats.filter((chat) => matchesChatFilter(chat, filter));
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

	get isFiltered(): boolean {
		return this.activeQuery.trim().length > 0;
	}

	get hasActiveQuery(): boolean {
		return this.activeQuery.trim().length > 0;
	}

	get allKnownTags(): string[] {
		const chats = this.#getChats();
		return Array.from(new Set(chats.flatMap((c) => c.tags))).sort();
	}

	openSearchDialog(): void {
		this.searchDialogOpen = true;
		this.draftQuery = this.activeQuery;
		this.highlightedResultIndex = 0;
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

	setSavedSearches(searches: SavedChatSearch[]): void {
		this.savedSearches = searches;
	}
}
