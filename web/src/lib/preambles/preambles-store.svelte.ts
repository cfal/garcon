import { untrack } from 'svelte';
import { CatalogRefresh, runCatalogLoad } from '$lib/api/catalog-refresh.js';
import { ApiError } from '$lib/api/client.js';
import {
	createPreamble,
	getPreambles,
	removePreamble,
	reorderPreambles,
	updatePreamble,
} from '$lib/api/preambles.js';
import {
	PREAMBLE_ERROR_CODES,
	type Preamble,
	type PreambleDefinitionInput,
	type PreamblesSnapshot,
} from '$shared/preambles';

export type PreamblesStatus = 'idle' | 'loading' | 'ready' | 'error';

function scopesMatch(left: Preamble['scope'], right: Preamble['scope']): boolean {
	if (left.type !== right.type) return false;
	if (left.type === 'global' || right.type === 'global') return true;
	if (left.rules.length !== right.rules.length) return false;
	return left.rules.every((rule, index) => {
		const other = right.rules[index];
		return (
			other !== undefined &&
			(rule.executorId ?? null) === (other.executorId ?? null) &&
			rule.projectPath === other.projectPath &&
			rule.includeNested === other.includeNested
		);
	});
}

export function preamblesMatch(left: Preamble, right: Preamble): boolean {
	return (
		left.id === right.id &&
		left.enabled === right.enabled &&
		left.title === right.title &&
		(left.snippetShortName ?? undefined) === (right.snippetShortName ?? undefined) &&
		left.content === right.content &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		scopesMatch(left.scope, right.scope) &&
		left.agentIds.length === right.agentIds.length &&
		left.agentIds.every((id, index) => id === right.agentIds[index]) &&
		left.tagFilter.mode === right.tagFilter.mode &&
		left.tagFilter.tags.length === right.tagFilter.tags.length &&
		left.tagFilter.tags.every((tag, index) => tag === right.tagFilter.tags[index])
	);
}

function preambleSnapshotsMatch(left: PreamblesSnapshot, right: PreamblesSnapshot): boolean {
	return (
		left.revision === right.revision &&
		left.preambles.length === right.preambles.length &&
		left.preambles.every((entry, index) => {
			const other = right.preambles[index];
			return other !== undefined && preamblesMatch(entry, other);
		})
	);
}

export interface PreamblesStoreDeps {
	get?: typeof getPreambles;
	create?: typeof createPreamble;
	update?: typeof updatePreamble;
	remove?: typeof removePreamble;
	reorder?: typeof reorderPreambles;
}

export class PreamblesStore {
	status = $state<PreamblesStatus>('idle');
	snapshot = $state<PreamblesSnapshot | null>(null);
	error = $state<string | null>(null);
	isRefreshing = $state(false);
	invalidationVersion = $state(0);
	#loadPromise: Promise<PreamblesSnapshot> | null = null;
	#confirmed: PreamblesSnapshot | null = null;
	#installGeneration = 0;
	#refreshGeneration = 0;
	#lastRefreshSucceeded = false;
	#moveQueue: Promise<void> = Promise.resolve();
	readonly #refreshLoop = new CatalogRefresh(() => this.refresh(), () => this.#loadPromise !== null);

	constructor(private readonly deps: PreamblesStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get preambles() {
		return this.snapshot?.preambles ?? [];
	}

	async ensureLoaded(): Promise<PreamblesSnapshot> {
		return this.snapshot ?? this.refresh();
	}

	async ensureSnapshotForWrite(): Promise<PreamblesSnapshot> {
		if (!this.snapshot || !this.#lastRefreshSucceeded) {
			await this.refresh();
		} else if (!this.#loadPromise && !this.#refreshLoop.pending) {
			return this.snapshot;
		}
		while (this.#loadPromise || this.#refreshLoop.pending) {
			await (this.#refreshLoop.pending ?? this.#loadPromise);
		}
		if (!this.#lastRefreshSucceeded || !this.snapshot) {
			throw new Error(this.error ?? 'Failed to load preambles');
		}
		return this.snapshot;
	}

	async refresh(): Promise<PreamblesSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		if (!this.snapshot) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		this.#lastRefreshSucceeded = false;
		const generation = this.#installGeneration;
		const get = this.deps.get ?? getPreambles;
		this.#loadPromise = get()
			.then((next) => {
				if (
					this.#installGeneration !== generation &&
					this.#confirmed &&
					next.revision <= this.#confirmed.revision
				) {
					this.#lastRefreshSucceeded = true;
					return this.snapshot ?? this.#confirmed;
				}
				return this.#installSnapshot(next);
			})
			.catch((error) => {
				if (this.#installGeneration === generation) {
					this.#lastRefreshSucceeded = false;
					this.error = error instanceof Error ? error.message : 'Failed to load preambles';
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
		this.invalidationVersion += 1;
		if (!this.snapshot && this.status === 'idle') return Promise.resolve();
		return untrack(() => this.#refreshLoop.request());
	}

	async create(definition: PreambleDefinitionInput): Promise<PreamblesSnapshot> {
		const current = await this.#requireSnapshot();
		const refreshGeneration = this.#refreshGeneration;
		const installGeneration = this.#installGeneration;
		try {
			const create = this.deps.create ?? createPreamble;
			return await this.#applyMutationSnapshot(
				(await create({
					expectedRevision: current.revision,
					preamble: definition,
				})).snapshot,
				refreshGeneration,
				installGeneration,
			);
		} catch (error) {
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	async update(
		id: string,
		definition: PreambleDefinitionInput,
		expectedRevision: number,
	): Promise<PreamblesSnapshot> {
		await this.#requireSnapshot();
		const refreshGeneration = this.#refreshGeneration;
		const installGeneration = this.#installGeneration;
		try {
			const update = this.deps.update ?? updatePreamble;
			return await this.#applyMutationSnapshot(
				(await update({
					expectedRevision,
					id,
					preamble: definition,
				})).snapshot,
				refreshGeneration,
				installGeneration,
			);
		} catch (error) {
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	async remove(id: string, expectedRevision: number): Promise<PreamblesSnapshot> {
		await this.#requireSnapshot();
		const refreshGeneration = this.#refreshGeneration;
		const installGeneration = this.#installGeneration;
		try {
			const remove = this.deps.remove ?? removePreamble;
			return await this.#applyMutationSnapshot(
				(await remove({
					expectedRevision,
					id,
				})).snapshot,
				refreshGeneration,
				installGeneration,
			);
		} catch (error) {
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	move(id: string, direction: 'up' | 'down'): Promise<void> {
		const run = this.#moveQueue.then(() => this.#runMove(id, direction));
		this.#moveQueue = run.catch(() => undefined);
		return run;
	}

	async #runMove(id: string, direction: 'up' | 'down'): Promise<void> {
		const current = await this.#requireSnapshot();
		const index = current.preambles.findIndex((preamble) => preamble.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= current.preambles.length) return;
		const preambles = [...current.preambles];
		[preambles[index], preambles[target]] = [preambles[target], preambles[index]];
		const generation = this.#installGeneration;
		const refreshGeneration = this.#refreshGeneration;
		this.snapshot = { ...current, preambles };
		try {
			const reorder = this.deps.reorder ?? reorderPreambles;
			await this.#applyMutationSnapshot(
				(await reorder({
					expectedRevision: current.revision,
					orderedPreambleIds: preambles.map((preamble) => preamble.id),
				})).snapshot,
				refreshGeneration,
				generation,
			);
		} catch (error) {
			if (this.#installGeneration === generation) this.snapshot = this.#confirmed;
			await this.#refreshAfterStaleError(error);
			throw error;
		}
	}

	applySnapshot(next: PreamblesSnapshot): PreamblesSnapshot {
		if (this.#confirmed && next.revision < this.#confirmed.revision) {
			return this.snapshot ?? this.#confirmed;
		}
		return this.#installSnapshot(next);
	}

	async #applyMutationSnapshot(
		next: PreamblesSnapshot,
		refreshGeneration: number,
		installGeneration: number,
	): Promise<PreamblesSnapshot> {
		if (this.#refreshGeneration !== refreshGeneration || this.#loadPromise !== null) {
			await this.refreshIfLoaded();
			if (!this.#lastRefreshSucceeded) {
				if (
					this.#installGeneration !== installGeneration &&
					this.#confirmed !== null &&
					preambleSnapshotsMatch(this.#confirmed, next)
				) {
					return this.snapshot ?? this.#confirmed;
				}
				// Do not keep a potentially pre-restore snapshot eligible for local expansion after reconciliation fails.
				this.#invalidateSnapshot('Failed to load preambles');
				return next;
			}
			return this.snapshot ?? this.#confirmed ?? next;
		}
		return this.applySnapshot(next);
	}

	#installSnapshot(next: PreamblesSnapshot): PreamblesSnapshot {
		this.snapshot = next;
		this.#confirmed = next;
		this.status = 'ready';
		this.error = null;
		this.#installGeneration += 1;
		this.#lastRefreshSucceeded = true;
		return next;
	}

	#invalidateSnapshot(fallbackMessage: string): void {
		this.snapshot = null;
		this.#confirmed = null;
		this.status = 'error';
		this.error ??= fallbackMessage;
		this.#installGeneration += 1;
	}

	async #requireSnapshot(): Promise<PreamblesSnapshot> {
		return this.#confirmed ?? this.ensureLoaded();
	}

	async #refreshAfterStaleError(error: unknown): Promise<void> {
		if (!(error instanceof ApiError)) return;
		if (error.errorCode === PREAMBLE_ERROR_CODES.revisionConflict) {
			await this.refreshIfLoaded();
			return;
		}
		if (error.errorCode === PREAMBLE_ERROR_CODES.notFound) {
			await this.refreshIfLoaded();
			if (!this.#lastRefreshSucceeded) {
				this.#invalidateSnapshot('Failed to load preambles');
			}
		}
	}
}

export function createPreamblesStore(deps?: PreamblesStoreDeps): PreamblesStore {
	return new PreamblesStore(deps);
}
