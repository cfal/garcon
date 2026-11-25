import { createSnippet, getSnippets, removeSnippet, updateSnippet } from '$lib/api/snippets.js';
import {
	VersionedCatalogStore,
	type VersionedCatalogStatus,
} from '$lib/stores/versioned-catalog-store.svelte.js';
import {
	SNIPPET_ERROR_CODES,
	type Snippet,
	type SnippetDefinitionInput,
	type SnippetsSnapshot,
} from '$shared/snippets';

function snippetsDiffer(left: readonly Snippet[], right: readonly Snippet[]): boolean {
	if (left.length !== right.length) return true;
	return left.some((a, index) => {
		const b = right[index]!;
		return (
			a.id !== b.id ||
			a.shortName !== b.shortName ||
			a.template !== b.template ||
			a.defaultArguments !== b.defaultArguments ||
			a.createdAt !== b.createdAt ||
			a.updatedAt !== b.updatedAt
		);
	});
}

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
			entriesDiffer: (left, right) => snippetsDiffer(left.snippets, right.snippets),
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

	reconcileAfterReconnect(): Promise<void> {
		return this.#catalog.reconcileAfterReconnect();
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

	update(id: string, definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const update = this.deps.update ?? updateSnippet;
		return this.#catalog.mutate((current) =>
			update({ expectedRevision: current.revision, id, snippet: definition }),
		);
	}

	remove(id: string): Promise<SnippetsSnapshot> {
		const remove = this.deps.remove ?? removeSnippet;
		return this.#catalog.mutate((current) =>
			remove({ expectedRevision: current.revision, id }),
		);
	}

	applySnapshot(nextSnapshot: SnippetsSnapshot): SnippetsSnapshot {
		return this.#catalog.applySnapshot(nextSnapshot);
	}
}

export function createSnippetsStore(deps?: SnippetsStoreDeps): SnippetsStore {
	return new SnippetsStore(deps);
}
