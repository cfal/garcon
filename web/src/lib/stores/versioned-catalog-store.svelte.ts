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
	// Compares entries within one revision so an authoritative GET can detect a same-revision restore.
	readonly entriesDiffer: (left: Snapshot, right: Snapshot) => boolean;
}

export class VersionedCatalogStore<Snapshot extends VersionedCatalogSnapshot> {
	status = $state<VersionedCatalogStatus>('idle');
	snapshot = $state<Snapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	invalidationVersion = $state(0);
	#refreshLoopActive = $state(false);
	#confirmed: Snapshot | null = null;
	#previewRevision = 0;
	#seq = 0;
	#appliedSeq = 0;
	#lastMutationAckSeq = 0;
	#resetSeq = 0;
	#lastReadFailureSeq = 0;
	#lastError: unknown = null;
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

	async refresh(): Promise<Snapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const requestSeq = ++this.#seq;
		if (this.snapshot) this.isRefreshing = true;
		else {
			this.status = 'loading';
			this.error = null;
		}
		this.#lastError = null;
		let needsReconcileAfterFailure = false;
		this.#loadPromise = this.options
			.load()
			.then((next) => {
				// Ignore reads started before a reconnect or reset so the queued GET establishes state.
				if (requestSeq < this.#resetSeq) {
					return this.snapshot ?? next;
				}
				const confirmed = this.#confirmed;
				// Ignore reads overtaken by a concurrent mutation unless the read observed a newer revision.
				if (requestSeq < this.#appliedSeq) {
					if (confirmed && next.revision <= confirmed.revision) {
						return this.snapshot ?? confirmed;
					}
					return this.#installSnapshot(next, requestSeq);
				}
				// A lower revision or changed same-revision confirmed catalog from an authoritative GET
				// indicates a reset or restore; advance the reset boundary so older in-flight mutations reconcile.
				if (
					confirmed &&
					(next.revision < confirmed.revision ||
						(next.revision === confirmed.revision &&
							this.options.entriesDiffer(confirmed, next)))
				) {
					this.#resetSeq = ++this.#seq;
					return this.#installSnapshot(next, this.#resetSeq);
				}
				return this.#installSnapshot(next, requestSeq);
			})
			.catch((error) => {
				if (requestSeq >= this.#resetSeq) {
					this.#lastReadFailureSeq = ++this.#seq;
					this.#lastError = error;
					this.error = error instanceof Error ? error.message : this.options.loadErrorMessage;
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
						if (!joinedExistingLoad && !this.#refreshRequested) return;
					}
					if (joinedExistingLoad) this.#refreshRequested = true;
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
	// An optional preview is displayed while in flight and rolled back on failure or reset-withhold
	// only if no newer preview or confirmed snapshot has superseded it.
	async mutate(
		send: (current: Snapshot) => Promise<{ readonly snapshot: Snapshot }>,
		options: { readonly preview?: Snapshot } = {},
	): Promise<Snapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const rollback = options.preview ? this.#showPreview(options.preview) : null;
		const dispatchSeq = ++this.#seq;
		try {
			const result = await send(current);
			if (dispatchSeq < this.#resetSeq) rollback?.();
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
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
		return this.#installSnapshot(next, ++this.#seq);
	}

	#showPreview(next: Snapshot): () => void {
		const previous = this.snapshot!;
		const marker = this.#previewRevision + 1;
		this.#previewRevision = marker;
		this.snapshot = next;
		return () => {
			if (this.#previewRevision === marker) this.snapshot = previous;
		};
	}

	#installSnapshot(next: Snapshot, seq: number, clearError = true): Snapshot {
		this.snapshot = next;
		this.#confirmed = next;
		this.status = 'ready';
		if (clearError) {
			this.error = null;
			this.#lastError = null;
		}
		this.#appliedSeq = Math.max(this.#appliedSeq, seq);
		this.#previewRevision += 1;
		return next;
	}

	// Withholds mutation results across reconnect or reset boundaries; after a same-connection
	// read failure, retains a newer acknowledged snapshot without clearing the error before reconciling.
	async #applyMutationSnapshot(next: Snapshot, dispatchSeq: number): Promise<Snapshot> {
		this.#lastMutationAckSeq = ++this.#seq;
		if (dispatchSeq < this.#resetSeq) {
			await this.refreshIfLoaded();
			return this.snapshot ?? next;
		}
		const confirmed = this.#confirmed;
		if (dispatchSeq < this.#lastReadFailureSeq) {
			if (!confirmed || next.revision > confirmed.revision) {
				this.#installSnapshot(next, ++this.#seq, false);
			}
			await this.refreshIfLoaded();
			return this.snapshot ?? next;
		}
		if (confirmed) {
			if (next.revision < confirmed.revision) {
				return this.snapshot ?? confirmed;
			}
			if (
				next.revision === confirmed.revision &&
				this.options.entriesDiffer(confirmed, next)
			) {
				await this.refreshIfLoaded();
				return this.snapshot ?? confirmed;
			}
		}
		return this.#installSnapshot(next, ++this.#seq);
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
