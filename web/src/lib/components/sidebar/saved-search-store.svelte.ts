import {
	createSavedSearch,
	deleteSavedSearch as deleteSavedSearchApi,
	getSavedSearches,
	reorderSavedSearches as reorderSavedSearchesApi,
	updateSavedSearch as updateSavedSearchApi,
	type SavedChatSearch,
} from '$lib/api/settings';
import * as m from '$lib/paraglide/messages.js';
import type { SavedSearchEditorState } from './SavedSearchEditorDialog.svelte';

type SavedSearchDialogOrigin = 'manager' | 'search-dialog';

export interface SavedSearchInput {
	title: string | null;
	query: string;
	showAsSidebarPill: boolean;
	showInSidebarMenu: boolean;
	showInSearchDialog: boolean;
}

export interface SavedSearchStoreDeps {
	get draftQuery(): string;
	suspendSearchDialog: () => void;
	resumeSearchDialog: () => void;
	reportActionFailure: (logMessage: string, userMessage: string, error: unknown) => void;
}

export class SavedSearchStore {
	savedSearches = $state<SavedChatSearch[]>([]);
	managerOpen = $state(false);
	editorState = $state<SavedSearchEditorState | null>(null);
	deleteConfirmation = $state<{ id: string } | null>(null);
	deleteButtonRef = $state<HTMLButtonElement | null>(null);

	private managerOrigin = $state<'search-dialog' | null>(null);
	private editorOrigin = $state<SavedSearchDialogOrigin | null>(null);

	constructor(private readonly deps: SavedSearchStoreDeps) {}

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
	}

	async load(): Promise<void> {
		try {
			const result = await getSavedSearches();
			this.setSavedSearches(result.savedSearches);
		} catch (error) {
			this.deps.reportActionFailure(
				'Failed to load saved searches:',
				m.notifications_load_saved_searches_failed(),
				error,
			);
		}
	}

	openManagerFromSearchDialog(): void {
		this.deps.suspendSearchDialog();
		this.managerOrigin = 'search-dialog';
		this.managerOpen = true;
	}

	closeManager(): void {
		this.managerOpen = false;
		if (this.managerOrigin === 'search-dialog') {
			this.deps.resumeSearchDialog();
		}
		this.managerOrigin = null;
	}

	openEditorForCreate(): void {
		this.managerOpen = false;
		this.editorOrigin = 'manager';
		this.editorState = this.createEditorState(this.deps.draftQuery);
	}

	openEditorForCreateFromSearchDialog(): void {
		this.deps.suspendSearchDialog();
		this.editorOrigin = 'search-dialog';
		this.editorState = this.createEditorState(this.deps.draftQuery);
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
			const result = await updateSavedSearchApi(searchId, data);
			this.setSavedSearches(
				this.savedSearches.map((search) => (search.id === searchId ? result.savedSearch : search)),
			);
		} else {
			const result = await createSavedSearch(data);
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
			await deleteSavedSearchApi(id);
			this.setSavedSearches(this.savedSearches.filter((search) => search.id !== id));
		} catch (error) {
			this.deps.reportActionFailure(
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
			await reorderSavedSearchesApi(oldOrder, newOrder);
		} catch (error) {
			this.deps.reportActionFailure(
				'Failed to reorder saved searches:',
				m.notifications_reorder_saved_searches_failed(),
				error,
			);
			this.setSavedSearches(oldOrder.map((id) => byId.get(id)).filter(searchExists));
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
			this.deps.resumeSearchDialog();
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

function searchExists(search: SavedChatSearch | undefined): search is SavedChatSearch {
	return Boolean(search);
}
