import { untrack } from 'svelte';
import { runCatalogLoad } from '$lib/api/catalog-refresh.js';
import { ApiError } from '$lib/api/client.js';
import { createSnippet, getSnippets, removeSnippet, updateSnippet } from '$lib/api/snippets.js';
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
	#refreshLoopActive = $state(false);
	#seq = 0;
	#appliedSeq = 0;
	#lastMutationAckSeq = 0;
	#resetSeq = 0;
	#lastReadFailureSeq = 0;
	#lastError: unknown = null;
	#loadPromise: Promise<SnippetsSnapshot> | null = null;
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;

	constructor(private readonly deps: SnippetsStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get hasFreshSnapshot(): boolean {
		return (
			this.snapshot !== null &&
			!this.isRefreshing &&
			!this.#refreshLoopActive &&
			this.error === null
		);
	}

	get snippets() {
		return this.snapshot?.snippets ?? [];
	}

	async ensureLoaded(): Promise<SnippetsSnapshot> {
		while (!this.snapshot) {
			if (this.#refreshLoopPromise) {
				await this.#refreshLoopPromise;
				if (this.snapshot) return this.snapshot;
				if (this.#lastError !== null) throw this.#lastError;
			}
			const resetSeq = this.#resetSeq;
			try {
				await this.refresh();
			} catch (error) {
				if (resetSeq !== this.#resetSeq) continue;
				throw error;
			}
		}
		return this.snapshot;
	}

	async refresh(): Promise<SnippetsSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const requestSeq = ++this.#seq;
		if (this.snapshot) this.isRefreshing = true;
		else {
			this.status = 'loading';
			this.error = null;
		}
		this.#lastError = null;
		const get = this.deps.get ?? getSnippets;
		let needsReconcileAfterFailure = false;
		this.#loadPromise = get()
			.then((nextSnapshot) => {
				// Ignore reads started before a reconnect or reset so the queued GET establishes state.
				if (requestSeq < this.#resetSeq) {
					return this.snapshot ?? nextSnapshot;
				}
				// Ignore reads overtaken by a concurrent mutation unless the read observed a newer revision.
				if (requestSeq < this.#appliedSeq) {
					if (this.snapshot && nextSnapshot.revision <= this.snapshot.revision) {
						return this.snapshot;
					}
					return this.#installSnapshot(nextSnapshot, requestSeq);
				}
				// A lower revision or changed same-revision catalog from an authoritative GET indicates
				// a reset or restore; advance the reset boundary so older in-flight mutations reconcile.
				if (
					this.snapshot &&
					(nextSnapshot.revision < this.snapshot.revision ||
						(nextSnapshot.revision === this.snapshot.revision &&
							snippetsDiffer(this.snapshot.snippets, nextSnapshot.snippets)))
				) {
					this.#resetSeq = ++this.#seq;
					return this.#installSnapshot(nextSnapshot, this.#resetSeq);
				}
				return this.#installSnapshot(nextSnapshot, requestSeq);
			})
			.catch((error) => {
				if (requestSeq >= this.#resetSeq) {
					this.#lastReadFailureSeq = ++this.#seq;
					this.#lastError = error;
					this.error = error instanceof Error ? error.message : 'Failed to load snippets';
					if (!this.snapshot) this.status = 'error';
					if (requestSeq < Math.max(this.#appliedSeq, this.#lastMutationAckSeq)) {
						if (this.#refreshLoopPromise) this.#refreshRequested = true;
						else needsReconcileAfterFailure = true;
					}
				}
				throw error;
			})
			.finally(() => {
				this.isRefreshing = false;
				this.#loadPromise = null;
				if (needsReconcileAfterFailure && !this.#refreshLoopPromise) {
					void this.refreshIfLoaded();
				}
			});
		return this.#loadPromise;
	}

	loadInBackground(): Promise<void> {
		return runCatalogLoad(() => this.ensureLoaded());
	}

	refreshInBackground(): Promise<void> {
		return runCatalogLoad(() => this.refresh());
	}

	// Marks a reconnect boundary so in-flight reads and mutations reconcile via a fresh GET.
	reconcileAfterReconnect(): Promise<void> {
		this.#resetSeq = ++this.#seq;
		return this.refreshIfLoaded();
	}

	async refreshIfLoaded(): Promise<void> {
		if (!this.snapshot && this.status === 'idle') return;
		this.#refreshRequested = true;
		if (this.#refreshLoopPromise) return this.#refreshLoopPromise;
		this.#refreshLoopActive = true;
		let loopFinished = false;
		const loop = untrack(async () => {
			try {
				do {
					this.#refreshRequested = false;
					const joinedExistingLoad = this.#loadPromise !== null;
					try {
						await this.refresh();
					} catch {
						if (!joinedExistingLoad && !this.#refreshRequested) return;
					}
					if (joinedExistingLoad) this.#refreshRequested = true;
				} while (this.#refreshRequested);
			} finally {
				loopFinished = true;
				this.#refreshLoopPromise = null;
				this.#refreshLoopActive = false;
			}
		});
		if (!loopFinished) this.#refreshLoopPromise = loop;
		return loop;
	}

	async create(definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const dispatchSeq = ++this.#seq;
		try {
			const create = this.deps.create ?? createSnippet;
			const result = await create({ expectedRevision: current.revision, snippet: definition });
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async update(id: string, definition: SnippetDefinitionInput): Promise<SnippetsSnapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const dispatchSeq = ++this.#seq;
		try {
			const update = this.deps.update ?? updateSnippet;
			const result = await update({
				expectedRevision: current.revision,
				id,
				snippet: definition,
			});
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string): Promise<SnippetsSnapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const dispatchSeq = ++this.#seq;
		try {
			const remove = this.deps.remove ?? removeSnippet;
			const result = await remove({ expectedRevision: current.revision, id });
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(nextSnapshot: SnippetsSnapshot): SnippetsSnapshot {
		if (this.snapshot && nextSnapshot.revision < this.snapshot.revision) return this.snapshot;
		return this.#installSnapshot(nextSnapshot, ++this.#seq);
	}

	#installSnapshot(
		nextSnapshot: SnippetsSnapshot,
		seq: number,
		clearError = true,
	): SnippetsSnapshot {
		this.snapshot = nextSnapshot;
		this.status = 'ready';
		if (clearError) {
			this.error = null;
			this.#lastError = null;
		}
		this.#appliedSeq = Math.max(this.#appliedSeq, seq);
		return nextSnapshot;
	}

	// Withholds mutation results across reconnect or reset boundaries; after a same-connection
	// read failure, retains the acknowledged mutation snapshot without clearing the error before reconciling.
	async #applyMutationSnapshot(
		nextSnapshot: SnippetsSnapshot,
		dispatchSeq: number,
	): Promise<SnippetsSnapshot> {
		this.#lastMutationAckSeq = ++this.#seq;
		if (dispatchSeq < this.#resetSeq) {
			await this.refreshIfLoaded();
			return this.snapshot ?? nextSnapshot;
		}
		if (dispatchSeq < this.#lastReadFailureSeq) {
			if (!this.snapshot || nextSnapshot.revision > this.snapshot.revision) {
				this.#installSnapshot(nextSnapshot, ++this.#seq, false);
			}
			await this.refreshIfLoaded();
			return this.snapshot ?? nextSnapshot;
		}
		if (this.snapshot) {
			if (nextSnapshot.revision < this.snapshot.revision) {
				return this.snapshot;
			}
			if (
				nextSnapshot.revision === this.snapshot.revision &&
				snippetsDiffer(this.snapshot.snippets, nextSnapshot.snippets)
			) {
				await this.refreshIfLoaded();
				return this.snapshot;
			}
		}
		return this.#installSnapshot(nextSnapshot, ++this.#seq);
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (error instanceof ApiError && error.errorCode === SNIPPET_ERROR_CODES.revisionConflict) {
			await this.refreshIfLoaded();
		}
	}
}

export function createSnippetsStore(deps?: SnippetsStoreDeps): SnippetsStore {
	return new SnippetsStore(deps);
}
