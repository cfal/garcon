import { untrack } from 'svelte';
import { runCatalogLoad } from '$lib/api/catalog-refresh.js';
import { ApiError } from '$lib/api/client.js';

export type VersionedCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface VersionedCatalogSnapshot {
	readonly revision: number;
}

export interface VersionedCatalogStoreOptions<Snapshot extends VersionedCatalogSnapshot> {
	readonly load: () => Promise<Snapshot>;
	readonly loadErrorMessage: string;
	readonly revisionConflictCode: string;
}

export class VersionedCatalogStore<Snapshot extends VersionedCatalogSnapshot> {
	status = $state<VersionedCatalogStatus>('idle');
	snapshot = $state<Snapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	invalidationVersion = $state(0);
	#refreshLoopActive = $state(false);
	#activePreviews: Array<{ readonly snapshot: Snapshot }> = [];
	#confirmed: Snapshot | null = null;
	#installGeneration = 0;
	#loadPromise: Promise<Snapshot> | null = null;
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;

	constructor(private readonly options: VersionedCatalogStoreOptions<Snapshot>) {}

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

	async ensureLoaded(): Promise<Snapshot> {
		if (this.snapshot) return this.snapshot;
		return this.refresh();
	}

	async refresh(): Promise<Snapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const generation = this.#installGeneration;
		this.error = null;
		if (this.snapshot) {
			this.isRefreshing = true;
		} else {
			this.status = 'loading';
		}
		this.#loadPromise = this.options
			.load()
			.then((next) => {
				// Ignore a GET overtaken by a newer confirmed install unless the GET observed a strictly higher revision.
				if (
					this.#installGeneration !== generation &&
					this.#confirmed &&
					next.revision <= this.#confirmed.revision
				) {
					return this.snapshot ?? this.#confirmed;
				}
				return this.#installSnapshot(next);
			})
			.catch((error) => {
				// Do not let a stale pre-mutation GET error poison a newer confirmed snapshot.
				if (this.#installGeneration === generation) {
					this.error = error instanceof Error ? error.message : this.options.loadErrorMessage;
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

	async refreshIfLoaded(): Promise<void> {
		this.invalidationVersion += 1;
		if (!this.snapshot && this.status === 'idle') return;
		this.#refreshRequested = true;
		if (this.#refreshLoopPromise) return this.#refreshLoopPromise;
		this.#refreshLoopActive = true;
		const loop = untrack(async () => {
			try {
				do {
					this.#refreshRequested = false;
					const joinedExistingLoad = this.#loadPromise !== null;
					try {
						await this.refresh();
					} catch {
						// Failed reads are already exposed on the store and do not trigger another GET on their own.
					}
					this.#refreshRequested ||= joinedExistingLoad;
				} while (this.#refreshRequested);
			} finally {
				this.#refreshLoopPromise = null;
				this.#refreshLoopActive = false;
			}
		});
		this.#refreshLoopPromise = loop;
		return loop;
	}

	// Sends a mutation against the loaded catalog and applies the acknowledged snapshot.
	// An optional preview is displayed while in flight and rolled back on failure
	// or superseded lower-revision acknowledgement.
	async mutate(
		send: (current: Snapshot) => Promise<{ readonly snapshot: Snapshot }>,
		options: { readonly preview?: Snapshot } = {},
	): Promise<Snapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const rollback = options.preview ? this.#showPreview(options.preview) : null;
		try {
			const result = await send(current);
			if (this.#confirmed && result.snapshot.revision < this.#confirmed.revision) {
				rollback?.();
			}
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			rollback?.();
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(next: Snapshot): Snapshot {
		if (this.#confirmed && next.revision < this.#confirmed.revision) {
			return this.snapshot ?? this.#confirmed;
		}
		return this.#installSnapshot(next);
	}

	#showPreview(next: Snapshot): () => void {
		const entry = { snapshot: next };
		this.#activePreviews.push(entry);
		this.snapshot = next;
		return () => {
			const index = this.#activePreviews.indexOf(entry);
			if (index === -1) return;
			this.#activePreviews.splice(index, 1);
			this.snapshot = this.#activePreviews.at(-1)?.snapshot ?? this.#confirmed;
		};
	}

	#installSnapshot(next: Snapshot): Snapshot {
		this.snapshot = next;
		this.#confirmed = next;
		this.status = 'ready';
		this.error = null;
		this.#installGeneration += 1;
		this.#activePreviews = [];
		return next;
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (
			error instanceof ApiError &&
			error.errorCode === this.options.revisionConflictCode
		) {
			await this.refreshIfLoaded();
		}
	}
}
