import {
	createSavedSearch,
	deleteSavedSearch as deleteSavedSearchApi,
	getSavedSearches,
	reorderSavedSearches as reorderSavedSearchesApi,
	updateSavedSearch as updateSavedSearchApi,
	type SavedChatSearch,
} from '$lib/api/settings';
import * as m from '$lib/paraglide/messages.js';

export interface SavedSearchInput {
	title: string | null;
	query: string;
	showAsSidebarPill: boolean;
	showInSidebarMenu: boolean;
	showInSearchDialog: boolean;
}

export interface SavedSearchesDeps {
	notifyError: (message: string) => void;
	getSavedSearches?: typeof getSavedSearches;
	createSavedSearch?: typeof createSavedSearch;
	updateSavedSearch?: typeof updateSavedSearchApi;
	deleteSavedSearch?: typeof deleteSavedSearchApi;
	reorderSavedSearches?: typeof reorderSavedSearchesApi;
	logError?: (message: string, error: unknown) => void;
}

export class SavedSearchesStore {
	searches = $state.raw<SavedChatSearch[]>([]);
	loaded = $state(false);
	loading = $state(false);
	private loadPromise: Promise<void> | null = null;

	constructor(private readonly deps: SavedSearchesDeps) {}

	sidebarPillSearches = $derived(this.searches.filter((search) => search.showAsSidebarPill));
	sidebarMenuSearches = $derived(this.searches.filter((search) => search.showInSidebarMenu));
	searchDialogSavedSearches = $derived(this.searches.filter((search) => search.showInSearchDialog));

	setSavedSearches(searches: SavedChatSearch[]): void {
		this.searches = searches;
		this.loaded = true;
	}

	loadSavedSearches(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		if (this.loadPromise) return this.loadPromise;

		this.loading = true;
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
				this.loading = false;
				this.loadPromise = null;
			});

		return this.loadPromise;
	}

	async save(data: SavedSearchInput, searchId?: string): Promise<void> {
		if (searchId) {
			const updateSearch = this.deps.updateSavedSearch ?? updateSavedSearchApi;
			const result = await updateSearch(searchId, data);
			this.setSavedSearches(
				this.searches.map((search) => (search.id === searchId ? result.savedSearch : search)),
			);
		} else {
			const createSearch = this.deps.createSavedSearch ?? createSavedSearch;
			const result = await createSearch(data);
			this.setSavedSearches([...this.searches, result.savedSearch]);
		}
	}

	async delete(id: string): Promise<void> {
		try {
			const deleteSearch = this.deps.deleteSavedSearch ?? deleteSavedSearchApi;
			await deleteSearch(id);
			this.setSavedSearches(this.searches.filter((search) => search.id !== id));
		} catch (error) {
			this.reportActionFailure(
				'Failed to delete saved search:',
				m.notifications_delete_saved_search_failed(),
				error,
			);
		}
	}

	async reorder(oldOrder: string[], newOrder: string[]): Promise<void> {
		const byId = new Map(this.searches.map((search) => [search.id, search]));
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

	private reportActionFailure(logMessage: string, userMessage: string, error: unknown): void {
		this.deps.logError?.(logMessage, error);
		this.deps.notifyError(userMessage);
	}
}

function searchExists(search: SavedChatSearch | undefined): search is SavedChatSearch {
	return Boolean(search);
}
