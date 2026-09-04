import { untrack } from 'svelte';
import { ApiError } from '$lib/api/client.js';
import {
	createPreamble,
	getPreambles,
	removePreamble,
	reorderPreambles,
	updatePreamble,
} from '$lib/api/preambles.js';
import type { PreambleDefinitionInput, PreamblesSnapshot } from '$shared/preambles';

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
	#loadPromise: Promise<PreamblesSnapshot> | null = null;
	#refreshLoopPromise: Promise<void> | null = null;
	#refreshRequested = false;
	#localRevision = 0;

	constructor(private readonly deps: PreamblesStoreDeps = {}) {}

	get hasLoaded(): boolean {
		return this.snapshot !== null;
	}

	get preambles() {
		return this.snapshot?.preambles ?? [];
	}

	async ensureLoaded(): Promise<PreamblesSnapshot> {
		return this.snapshot ?? this.refresh({ initial: true });
	}

	async refresh(options: { initial?: boolean } = {}): Promise<PreamblesSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		const initial = options.initial === true || !this.snapshot;
		if (initial) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		const get = this.deps.get ?? getPreambles;
		this.#loadPromise = get()
			.then((next) => this.applySnapshot(next))
			.catch((error) => {
				this.error = error instanceof Error ? error.message : 'Failed to load preambles';
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

	async create(definition: PreambleDefinitionInput): Promise<PreamblesSnapshot> {
		const current = await this.#requireSnapshot();
		try {
			const create = this.deps.create ?? createPreamble;
			return this.applySnapshot((await create({
				expectedRevision: current.revision,
				preamble: definition,
			})).snapshot);
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
		await this.#requireSnapshot();
		try {
			const update = this.deps.update ?? updatePreamble;
			return this.applySnapshot((await update({
				expectedRevision,
				id,
				preamble: definition,
			})).snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string): Promise<PreamblesSnapshot> {
		const current = await this.#requireSnapshot();
		try {
			const remove = this.deps.remove ?? removePreamble;
			return this.applySnapshot((await remove({
				expectedRevision: current.revision,
				id,
			})).snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async move(id: string, direction: 'up' | 'down'): Promise<void> {
		const current = await this.#requireSnapshot();
		const index = current.preambles.findIndex((preamble) => preamble.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= current.preambles.length) return;
		const preambles = [...current.preambles];
		[preambles[index], preambles[target]] = [preambles[target], preambles[index]];
		const optimisticMarker = this.#localRevision + 1;
		this.#localRevision = optimisticMarker;
		this.snapshot = { ...current, preambles };
		try {
			const reorder = this.deps.reorder ?? reorderPreambles;
			this.applySnapshot((await reorder({
				expectedRevision: current.revision,
				orderedPreambleIds: preambles.map((preamble) => preamble.id),
			})).snapshot);
		} catch (error) {
			if (this.#localRevision === optimisticMarker) this.snapshot = current;
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(next: PreamblesSnapshot): PreamblesSnapshot {
		if (this.snapshot && next.revision < this.snapshot.revision) return this.snapshot;
		this.snapshot = next;
		this.status = 'ready';
		this.error = null;
		this.#localRevision += 1;
		return next;
	}

	async #requireSnapshot(): Promise<PreamblesSnapshot> {
		return this.snapshot ?? this.ensureLoaded();
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (!(error instanceof ApiError) || error.status !== 409) return;
		try {
			await this.refresh();
		} catch {
			// The mutation conflict remains the actionable error.
		}
	}
}

export function createPreamblesStore(deps?: PreamblesStoreDeps): PreamblesStore {
	return new PreamblesStore(deps);
}
