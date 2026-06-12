import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createSavedSearch,
	deleteSavedSearch,
	getSavedSearches,
	reorderSavedSearches,
	updateSavedSearch,
	type SavedChatSearch,
} from '$lib/api/settings';
import { SavedSearchStore } from '../saved-search-store.svelte';

vi.mock('$lib/api/settings', async () => {
	const actual = await vi.importActual<typeof import('$lib/api/settings')>('$lib/api/settings');
	return {
		...actual,
		getSavedSearches: vi.fn(),
		createSavedSearch: vi.fn(),
		updateSavedSearch: vi.fn(),
		deleteSavedSearch: vi.fn(),
		reorderSavedSearches: vi.fn(),
	};
});

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

function createStore(draftQuery = 'tag:ops') {
	const suspendSearchDialog = vi.fn();
	const resumeSearchDialog = vi.fn();
	const reportActionFailure = vi.fn();
	const store = new SavedSearchStore({
		get draftQuery() {
			return draftQuery;
		},
		suspendSearchDialog,
		resumeSearchDialog,
		reportActionFailure,
	});
	return { store, suspendSearchDialog, resumeSearchDialog, reportActionFailure };
}

describe('SavedSearchStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

	it('loads searches and reports load failures', async () => {
		const { store, reportActionFailure } = createStore();
		const savedSearches = [makeSavedSearch({ id: 's1' })];
		vi.mocked(getSavedSearches).mockResolvedValue({ savedSearches });

		await store.load();
		expect(store.savedSearches).toEqual(savedSearches);

		vi.mocked(getSavedSearches).mockRejectedValue(new Error('network'));
		await store.load();

		expect(reportActionFailure).toHaveBeenCalledWith(
			'Failed to load saved searches:',
			'Failed to load saved searches.',
			expect.any(Error),
		);
	});

	it('suspends and restores the search dialog around create flow', () => {
		const { store, suspendSearchDialog, resumeSearchDialog } = createStore('tag:ops');

		store.openEditorForCreateFromSearchDialog();
		expect(suspendSearchDialog).toHaveBeenCalledOnce();
		expect(store.editorState?.query).toBe('tag:ops');

		store.closeEditor();
		expect(resumeSearchDialog).toHaveBeenCalledOnce();
	});

	it('creates and updates searches while restoring manager origin', async () => {
		const { store } = createStore('status:unread');
		const created = makeSavedSearch({ id: 'created', query: 'status:unread' });
		vi.mocked(createSavedSearch).mockResolvedValue({ success: true, savedSearch: created });

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

		const updated = makeSavedSearch({ id: 'created', query: 'tag:ops' });
		vi.mocked(updateSavedSearch).mockResolvedValue({ success: true, savedSearch: updated });

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
		const { store, reportActionFailure } = createStore();
		store.setSavedSearches([makeSavedSearch({ id: 's1' })]);
		vi.mocked(deleteSavedSearch).mockResolvedValue({ success: true });

		store.requestDelete('s1');
		await store.confirmDelete();
		expect(store.savedSearches).toEqual([]);

		store.setSavedSearches([makeSavedSearch({ id: 's2' })]);
		vi.mocked(deleteSavedSearch).mockRejectedValue(new Error('network'));

		store.requestDelete('s2');
		await store.confirmDelete();

		expect(store.savedSearches.map((search) => search.id)).toEqual(['s2']);
		expect(reportActionFailure).toHaveBeenCalledWith(
			'Failed to delete saved search:',
			'Failed to delete saved search.',
			expect.any(Error),
		);
	});

	it('rolls optimistic reorder back on failure', async () => {
		const { store, reportActionFailure } = createStore();
		store.setSavedSearches([
			makeSavedSearch({ id: 's1' }),
			makeSavedSearch({ id: 's2' }),
			makeSavedSearch({ id: 's3' }),
		]);
		vi.mocked(reorderSavedSearches).mockRejectedValue(new Error('network'));

		await store.reorder(['s1', 's2', 's3'], ['s3', 's1', 's2']);

		expect(store.savedSearches.map((search) => search.id)).toEqual(['s1', 's2', 's3']);
		expect(reportActionFailure).toHaveBeenCalledWith(
			'Failed to reorder saved searches:',
			'Failed to reorder saved searches.',
			expect.any(Error),
		);
	});
});
