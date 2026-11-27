import { untrack } from 'svelte';
import { CatalogRefresh, runCatalogLoad } from '$lib/api/catalog-refresh.js';
import { ApiError } from '$lib/api/client.js';
import { createSnippet, getSnippets, removeSnippet, updateSnippet } from '$lib/api/snippets.js';
import {
	SNIPPET_ERROR_CODES,
	type Snippet,
	type SnippetDefinitionInput,
	type SnippetsSnapshot,
} from '$shared/snippets';

export type SnippetsStatus = 'idle' | 'loading' | 'ready' | 'error';

export function snippetsMatch(left: Snippet, right: Snippet): boolean {
	return (
		left.id === right.id &&
		left.shortName === right.shortName &&
		left.template === right.template &&
		left.defaultArguments === right.defaultArguments &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt
	);
}

function snippetSnapshotsMatch(left: SnippetsSnapshot, right: SnippetsSnapshot): boolean {
	return (
		left.revision === right.revision &&
		left.snippets.length === right.snippets.length &&
		left.snippets.every((entry, index) => {
			const other = right.snippets[index];
			return other !== undefined && snippetsMatch(entry, other);
		})
	);
}

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
	#confirmed: SnippetsSnapshot | null = null;
	#installGeneration = 0;
	#refreshGeneration = 0;
	#lastRefreshSucceeded = false;
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

	async ensureSnapshotForWrite(): Promise<SnippetsSnapshot> {
		if (!this.snapshot || !this.#lastRefreshSucceeded) {
			await this.refresh();
		} else if (!this.#loadPromise && !this.#refreshLoop.pending) {
			return this.snapshot;
		}
		while (this.#loadPromise || this.#refreshLoop.pending) {
			await (this.#refreshLoop.pending ?? this.#loadPromise);
		}
		if (!this.#lastRefreshSucceeded || !this.snapshot) {
			throw new Error(this.error ?? 'Failed to load snippets');
		}
		return this.snapshot;
	}

	async refresh(): Promise<SnippetsSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		if (!this.snapshot) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		this.#lastRefreshSucceeded = false;
		const generation = this.#installGeneration;
		const get = this.deps.get ?? getSnippets;
		this.#loadPromise = get()
			.then((nextSnapshot) => {
				if (
					this.#installGeneration !== generation &&
					this.#confirmed &&
					nextSnapshot.revision <= this.#confirmed.revision
				) {
					this.#lastRefreshSucceeded = true;
					return this.snapshot ?? this.#confirmed;
				}
				return this.#installSnapshot(nextSnapshot);
			})
			.catch((error) => {
				if (this.#installGeneration === generation) {
					this.#lastRefreshSucceeded = false;
					this.error = error instanceof Error ? error.message : 'Failed to load snippets';
					if (!this.snapshot) this.status = 'error';
				} else {
					this.#lastRefreshSucceeded = true;
				}
				throw error;
			})
			.finally(() => {
				// Advance the read generation on failed GETs too so late write acks reconcile via a fresh read.
				this.#refreshGeneration += 1;
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
		const current = await this.#requireSnapshot();
		const refreshGeneration = this.#refreshGeneration;
		const installGeneration = this.#installGeneration;
		try {
			const create = this.deps.create ?? createSnippet;
			const result = await create({ expectedRevision: current.revision, snippet: definition });
			return await this.#applyMutationSnapshot(result.snapshot, refreshGeneration, installGeneration);
		} catch (error) {
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	async update(
		id: string,
		definition: SnippetDefinitionInput,
		expectedRevision: number,
	): Promise<SnippetsSnapshot> {
		await this.#requireSnapshot();
		const refreshGeneration = this.#refreshGeneration;
		const installGeneration = this.#installGeneration;
		try {
			const update = this.deps.update ?? updateSnippet;
			const result = await update({
				expectedRevision,
				id,
				snippet: definition,
			});
			return await this.#applyMutationSnapshot(result.snapshot, refreshGeneration, installGeneration);
		} catch (error) {
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	async remove(id: string, expectedRevision: number): Promise<SnippetsSnapshot> {
		await this.#requireSnapshot();
		const refreshGeneration = this.#refreshGeneration;
		const installGeneration = this.#installGeneration;
		try {
			const remove = this.deps.remove ?? removeSnippet;
			const result = await remove({ expectedRevision, id });
			return await this.#applyMutationSnapshot(result.snapshot, refreshGeneration, installGeneration);
		} catch (error) {
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	applySnapshot(nextSnapshot: SnippetsSnapshot): SnippetsSnapshot {
		if (this.#confirmed && nextSnapshot.revision < this.#confirmed.revision) {
			return this.snapshot ?? this.#confirmed;
		}
		return this.#installSnapshot(nextSnapshot);
	}

	async #applyMutationSnapshot(
		nextSnapshot: SnippetsSnapshot,
		refreshGeneration: number,
		installGeneration: number,
	): Promise<SnippetsSnapshot> {
		if (this.#refreshGeneration !== refreshGeneration || this.#loadPromise !== null) {
			await this.refreshIfLoaded();
			if (!this.#lastRefreshSucceeded) {
				if (
					this.#installGeneration !== installGeneration &&
					this.#confirmed !== null &&
					snippetSnapshotsMatch(this.#confirmed, nextSnapshot)
				) {
					return this.snapshot ?? this.#confirmed;
				}
				// Do not keep a potentially pre-restore snapshot eligible for local expansion after reconciliation fails.
				this.#invalidateSnapshot('Failed to load snippets');
				return nextSnapshot;
			}
			return this.snapshot ?? this.#confirmed ?? nextSnapshot;
		}
		return this.applySnapshot(nextSnapshot);
	}

	#installSnapshot(nextSnapshot: SnippetsSnapshot): SnippetsSnapshot {
		this.snapshot = nextSnapshot;
		this.#confirmed = nextSnapshot;
		this.status = 'ready';
		this.error = null;
		this.#installGeneration += 1;
		this.#lastRefreshSucceeded = true;
		return nextSnapshot;
	}

	#invalidateSnapshot(fallbackMessage: string): void {
		this.snapshot = null;
		this.#confirmed = null;
		this.status = 'error';
		this.error ??= fallbackMessage;
		this.#installGeneration += 1;
	}

	async #requireSnapshot(): Promise<SnippetsSnapshot> {
		return this.#confirmed ?? this.ensureLoaded();
	}

	async #refreshAfterStaleError(error: unknown): Promise<void> {
		if (!(error instanceof ApiError)) return;
		if (error.errorCode === SNIPPET_ERROR_CODES.revisionConflict) {
			await this.refreshIfLoaded();
			return;
		}
		if (error.errorCode === SNIPPET_ERROR_CODES.notFound) {
			await this.refreshIfLoaded();
			if (!this.#lastRefreshSucceeded) {
				this.#invalidateSnapshot('Failed to load snippets');
			}
		}
	}
}

export function createSnippetsStore(deps?: SnippetsStoreDeps): SnippetsStore {
	return new SnippetsStore(deps);
}
