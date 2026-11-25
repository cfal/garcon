import { untrack } from 'svelte';
import { runCatalogLoad } from '$lib/api/catalog-refresh.js';
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameScope(left: Preamble['scope'], right: Preamble['scope']): boolean {
	if (left.type !== right.type) return false;
	if (left.type === 'global') return true;
	return (
		right.type === 'project-paths' &&
		left.rules.length === right.rules.length &&
		left.rules.every((rule, index) => {
			const other = right.rules[index]!;
			return (
				(rule.executorId ?? null) === (other.executorId ?? null) &&
				rule.projectPath === other.projectPath &&
				rule.includeNested === other.includeNested
			);
		})
	);
}

function preamblesDiffer(left: readonly Preamble[], right: readonly Preamble[]): boolean {
	if (left.length !== right.length) return true;
	return left.some((a, index) => {
		const b = right[index]!;
		return (
			a.id !== b.id ||
			a.enabled !== b.enabled ||
			a.title !== b.title ||
			a.snippetShortName !== b.snippetShortName ||
			a.content !== b.content ||
			a.createdAt !== b.createdAt ||
			a.updatedAt !== b.updatedAt ||
			!sameScope(a.scope, b.scope) ||
			!sameStrings(a.agentIds, b.agentIds) ||
			a.tagFilter.mode !== b.tagFilter.mode ||
			!sameStrings(a.tagFilter.tags, b.tagFilter.tags)
		);
	});
}

export type PreamblesStatus = 'idle' | 'loading' | 'ready' | 'error';

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
	#refreshLoopActive = $state(false);
	#seq = 0;
	#appliedSeq = 0;
	#lastMutationAckSeq = 0;
	#resetSeq = 0;
	#lastReadFailureSeq = 0;
	#lastError: unknown = null;
	#loadPromise: Promise<PreamblesSnapshot> | null = null;
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;
	#localRevision = 0;
	#confirmedSnapshot: PreamblesSnapshot | null = null;

	constructor(private readonly deps: PreamblesStoreDeps = {}) {}

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

	get preambles() {
		return this.snapshot?.preambles ?? [];
	}

	async ensureLoaded(): Promise<PreamblesSnapshot> {
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

	async refresh(): Promise<PreamblesSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const requestSeq = ++this.#seq;
		if (this.snapshot) this.isRefreshing = true;
		else {
			this.status = 'loading';
			this.error = null;
		}
		this.#lastError = null;
		const get = this.deps.get ?? getPreambles;
		let needsReconcileAfterFailure = false;
		this.#loadPromise = get()
			.then((next) => {
				// Ignore reads started before a reconnect or reset so the queued GET establishes state.
				if (requestSeq < this.#resetSeq) {
					return this.snapshot ?? next;
				}
				const confirmed = this.#confirmedSnapshot;
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
							preamblesDiffer(confirmed.preambles, next.preambles)))
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
					this.error = error instanceof Error ? error.message : 'Failed to load preambles';
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

	async create(definition: PreambleDefinitionInput): Promise<PreamblesSnapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const dispatchSeq = ++this.#seq;
		try {
			const create = this.deps.create ?? createPreamble;
			const result = await create({
				expectedRevision: current.revision,
				preamble: definition,
			});
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async update(
		id: string,
		definition: PreambleDefinitionInput,
		expectedRevision: number,
	): Promise<PreamblesSnapshot> {
		if (!this.snapshot) await this.ensureLoaded();
		const dispatchSeq = ++this.#seq;
		try {
			const update = this.deps.update ?? updatePreamble;
			const result = await update({
				expectedRevision,
				id,
				preamble: definition,
			});
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string): Promise<PreamblesSnapshot> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const dispatchSeq = ++this.#seq;
		try {
			const remove = this.deps.remove ?? removePreamble;
			const result = await remove({
				expectedRevision: current.revision,
				id,
			});
			return await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async move(id: string, direction: 'up' | 'down'): Promise<void> {
		const current = this.snapshot ?? (await this.ensureLoaded());
		const index = current.preambles.findIndex((preamble) => preamble.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= current.preambles.length) return;
		const preambles = [...current.preambles];
		[preambles[index], preambles[target]] = [preambles[target], preambles[index]];
		const optimisticMarker = this.#localRevision + 1;
		this.#localRevision = optimisticMarker;
		this.snapshot = { ...current, preambles };
		const dispatchSeq = ++this.#seq;
		try {
			const reorder = this.deps.reorder ?? reorderPreambles;
			const result = await reorder({
				expectedRevision: current.revision,
				orderedPreambleIds: preambles.map((preamble) => preamble.id),
			});
			if (dispatchSeq < this.#resetSeq && this.#localRevision === optimisticMarker) {
				this.snapshot = current;
			}
			await this.#applyMutationSnapshot(result.snapshot, dispatchSeq);
		} catch (error) {
			if (this.#localRevision === optimisticMarker) this.snapshot = current;
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(next: PreamblesSnapshot): PreamblesSnapshot {
		if (this.snapshot && next.revision < this.snapshot.revision) return this.snapshot;
		return this.#installSnapshot(next, ++this.#seq);
	}

	#installSnapshot(
		next: PreamblesSnapshot,
		seq: number,
		clearError = true,
	): PreamblesSnapshot {
		this.snapshot = next;
		this.#confirmedSnapshot = next;
		this.status = 'ready';
		if (clearError) {
			this.error = null;
			this.#lastError = null;
		}
		this.#appliedSeq = Math.max(this.#appliedSeq, seq);
		this.#localRevision += 1;
		return next;
	}

	// Withholds mutation results across reconnect or reset boundaries; after a same-connection
	// read failure, retains the acknowledged mutation snapshot without clearing the error before reconciling.
	async #applyMutationSnapshot(
		next: PreamblesSnapshot,
		dispatchSeq: number,
	): Promise<PreamblesSnapshot> {
		this.#lastMutationAckSeq = ++this.#seq;
		if (dispatchSeq < this.#resetSeq) {
			await this.refreshIfLoaded();
			return this.snapshot ?? next;
		}
		const confirmed = this.#confirmedSnapshot;
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
				preamblesDiffer(confirmed.preambles, next.preambles)
			) {
				await this.refreshIfLoaded();
				return this.snapshot ?? confirmed;
			}
		}
		return this.#installSnapshot(next, ++this.#seq);
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (
			!(error instanceof ApiError) ||
			error.errorCode !== PREAMBLE_ERROR_CODES.revisionConflict
		)
			return;
		await this.refreshIfLoaded();
	}
}

export function createPreamblesStore(deps?: PreamblesStoreDeps): PreamblesStore {
	return new PreamblesStore(deps);
}
