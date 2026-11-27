import { untrack } from 'svelte';
import { CatalogRefresh, runCatalogLoad } from '$lib/api/catalog-refresh.js';
import { ApiError } from '$lib/api/client.js';
import { createSnippet, getSnippets, removeSnippet, updateSnippet } from '$lib/api/snippets.js';
import {
	SNIPPET_ERROR_CODES,
	type SnippetDefinitionInput,
	type SnippetsSnapshot,
} from '$shared/snippets';

export type SnippetsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SnippetsStoreDeps {
	get?: typeof getSnippets;
	create?: typeof createSnippet;
	update?: typeof updateSnippet;
	remove?: typeof removeSnippet;
}

export class SnippetsStore {
	status = $state<SnippetsStatus>('idle');
	snapshot = $state<SnippetsSnapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	#loadPromise: Promise<SnippetsSnapshot> | null = null;
	readonly #refreshLoop = new CatalogRefresh(() => this.refresh(), () => this.#loadPromise !== null);

	constructor(private readonly deps: SnippetsStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get snippets() {
		return this.snapshot?.snippets ?? [];
	}

	async ensureLoaded(): Promise<SnippetsSnapshot> {
		return this.snapshot ?? this.refresh();
	}

	async refresh(): Promise<SnippetsSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		if (!this.snapshot) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		const startRevision = this.snapshot?.revision ?? -1;
		const get = this.deps.get ?? getSnippets;
		this.#loadPromise = get()
			.then((nextSnapshot) => this.applySnapshot(nextSnapshot))
			.catch((error) => {
				if ((this.snapshot?.revision ?? -1) === startRevision) {
					this.error = error instanceof Error ? error.message : 'Failed to load snippets';
					if (!this.snapshot) this.status = 'error';
				}
				throw error;
			})
			.finally(() => {
				this.isRefreshing = false;
				this.#loadPromise = null;
			});
		return this.#loadPromise;
	}

	loadInBackground(): Promise<void> {
		return runCatalogLoad(() => this.ensureLoaded());
	}

	refreshInBackground(): Promise<void> {
		return runCatalogLoad(() => this.refresh());
	}

	refreshIfLoaded(): Promise<void> {
		if (!this.snapshot && this.status === 'idle') return Promise.resolve();
		return untrack(() => this.#refreshLoop.request());
	}

	async create(definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const current = await this.ensureLoaded();
		try {
			const create = this.deps.create ?? createSnippet;
			const result = await create({ expectedRevision: current.revision, snippet: definition });
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async update(
		id: string,
		definition: SnippetDefinitionInput,
		expectedRevision: number,
	): Promise<SnippetsSnapshot> {
		await this.ensureLoaded();
		try {
			const update = this.deps.update ?? updateSnippet;
			const result = await update({
				expectedRevision,
				id,
				snippet: definition,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string, expectedRevision: number): Promise<SnippetsSnapshot> {
		await this.ensureLoaded();
		try {
			const remove = this.deps.remove ?? removeSnippet;
			const result = await remove({ expectedRevision, id });
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(nextSnapshot: SnippetsSnapshot): SnippetsSnapshot {
		if (this.snapshot && nextSnapshot.revision < this.snapshot.revision) return this.snapshot;
		this.snapshot = nextSnapshot;
		this.status = 'ready';
		this.error = null;
		return nextSnapshot;
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (
			error instanceof ApiError &&
			(error.errorCode === SNIPPET_ERROR_CODES.revisionConflict ||
				error.errorCode === SNIPPET_ERROR_CODES.notFound)
		) {
			await this.refreshIfLoaded();
		}
	}
}

export function createSnippetsStore(deps?: SnippetsStoreDeps): SnippetsStore {
	return new SnippetsStore(deps);
}
