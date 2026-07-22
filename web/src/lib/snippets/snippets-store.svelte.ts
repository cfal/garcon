import { untrack } from 'svelte';
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
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;

	constructor(private readonly deps: SnippetsStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get snippets() {
		return this.snapshot?.snippets ?? [];
	}

	async ensureLoaded(): Promise<SnippetsSnapshot> {
		return this.snapshot ?? this.refresh({ initial: true });
	}

	async refresh(options: { initial?: boolean } = {}): Promise<SnippetsSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const initial = options.initial === true || !this.snapshot;
		if (initial) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		const get = this.deps.get ?? getSnippets;
		this.#loadPromise = get()
			.then((nextSnapshot) => this.applySnapshot(nextSnapshot))
			.catch((error) => {
				this.error = error instanceof Error ? error.message : 'Failed to load snippets';
				if (!this.snapshot) this.status = 'error';
				throw error;
			})
			.finally(() => {
				this.isRefreshing = false;
				this.#loadPromise = null;
			});
		return this.#loadPromise;
	}

	async refreshIfLoaded(): Promise<void> {
		if (!this.snapshot && this.status === 'idle') return;
		this.#refreshRequested = true;
		if (this.#refreshLoopPromise) return this.#refreshLoopPromise;
		this.#refreshLoopPromise = untrack(async () => {
			do {
				this.#refreshRequested = false;
				const joinedExistingLoad = this.#loadPromise !== null;
				try {
					await this.refresh();
				} catch {
					return;
				}
				if (joinedExistingLoad) this.#refreshRequested = true;
			} while (this.#refreshRequested);
		}).finally(() => {
			this.#refreshLoopPromise = null;
		});
		return this.#refreshLoopPromise;
	}

	async create(definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const current = await this.#requireSnapshot();
		try {
			const create = this.deps.create ?? createSnippet;
			const result = await create({ expectedRevision: current.revision, snippet: definition });
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async update(id: string, definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const current = await this.#requireSnapshot();
		try {
			const update = this.deps.update ?? updateSnippet;
			const result = await update({
				expectedRevision: current.revision,
				id,
				snippet: definition,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string): Promise<SnippetsSnapshot> {
		const current = await this.#requireSnapshot();
		try {
			const remove = this.deps.remove ?? removeSnippet;
			const result = await remove({ expectedRevision: current.revision, id });
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

	async #requireSnapshot(): Promise<SnippetsSnapshot> {
		return this.snapshot ?? this.ensureLoaded();
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (error instanceof ApiError && error.errorCode === SNIPPET_ERROR_CODES.revisionConflict) {
			const joinedExistingLoad = this.#loadPromise !== null;
			try {
				await this.refresh();
				if (joinedExistingLoad) await this.refresh();
			} catch {
				// The original conflict remains the actionable error.
			}
		}
	}
}

export function createSnippetsStore(deps?: SnippetsStoreDeps): SnippetsStore {
	return new SnippetsStore(deps);
}
