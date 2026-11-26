import { createSnippet, getSnippets, removeSnippet, updateSnippet } from '$lib/api/snippets.js';
import {
	VersionedCatalogStore,
	type VersionedCatalogStatus,
} from '$lib/stores/versioned-catalog-store.svelte.js';
import {
	SNIPPET_ERROR_CODES,
	type SnippetDefinitionInput,
	type SnippetsSnapshot,
} from '$shared/snippets';

export type SnippetsStatus = VersionedCatalogStatus;

export interface SnippetsStoreDeps {
	get?: typeof getSnippets;
	create?: typeof createSnippet;
	update?: typeof updateSnippet;
	remove?: typeof removeSnippet;
}

export class SnippetsStore {
	readonly #catalog: VersionedCatalogStore<SnippetsSnapshot>;

	constructor(private readonly deps: SnippetsStoreDeps = {}) {
		this.#catalog = new VersionedCatalogStore<SnippetsSnapshot>({
			load: () => (this.deps.get ?? getSnippets)(),
			loadErrorMessage: 'Failed to load snippets',
			revisionConflictCode: SNIPPET_ERROR_CODES.revisionConflict,
		});
	}

	get status(): SnippetsStatus {
		return this.#catalog.status;
	}

	get snapshot(): SnippetsSnapshot | null {
		return this.#catalog.snapshot;
	}

	get error(): string | null {
		return this.#catalog.error;
	}

	get isRefreshing(): boolean {
		return this.#catalog.isRefreshing;
	}

	get hasLoaded(): boolean {
		return this.#catalog.hasLoaded;
	}

	get hasFreshSnapshot(): boolean {
		return this.#catalog.hasFreshSnapshot;
	}

	get snippets() {
		return this.#catalog.snapshot?.snippets ?? [];
	}

	ensureLoaded(): Promise<SnippetsSnapshot> {
		return this.#catalog.ensureLoaded();
	}

	refresh(): Promise<SnippetsSnapshot> {
		return this.#catalog.refresh();
	}

	loadInBackground(): Promise<void> {
		return this.#catalog.loadInBackground();
	}

	refreshInBackground(): Promise<void> {
		return this.#catalog.refreshInBackground();
	}

	refreshIfLoaded(): Promise<void> {
		return this.#catalog.refreshIfLoaded();
	}

	create(definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const create = this.deps.create ?? createSnippet;
		return this.#catalog.mutate((current) =>
			create({ expectedRevision: current.revision, snippet: definition }),
		);
	}

	update(
		id: string,
		definition: SnippetDefinitionInput,
		expectedRevision: number,
	): Promise<SnippetsSnapshot> {
		const update = this.deps.update ?? updateSnippet;
		return this.#catalog.mutate(() => update({ expectedRevision, id, snippet: definition }));
	}

	remove(id: string, expectedRevision: number): Promise<SnippetsSnapshot> {
		const remove = this.deps.remove ?? removeSnippet;
		return this.#catalog.mutate(() => remove({ expectedRevision, id }));
	}

	applySnapshot(nextSnapshot: SnippetsSnapshot): SnippetsSnapshot {
		return this.#catalog.applySnapshot(nextSnapshot);
	}
}

export function createSnippetsStore(deps?: SnippetsStoreDeps): SnippetsStore {
	return new SnippetsStore(deps);
}
