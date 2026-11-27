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
	type PreambleDefinitionInput,
	type PreamblesSnapshot,
} from '$shared/preambles';

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
	#loadPromise: Promise<PreamblesSnapshot> | null = null;
	#confirmed: PreamblesSnapshot | null = null;
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

	async refresh(): Promise<PreamblesSnapshot> {
		if (this.#loadPromise) return this.#loadPromise;
		if (!this.snapshot) this.status = 'loading';
		else this.isRefreshing = true;
		this.error = null;
		const startRevision = this.#confirmed?.revision ?? -1;
		const get = this.deps.get ?? getPreambles;
		this.#loadPromise = get()
			.then((next) => this.applySnapshot(next))
			.catch((error) => {
				if ((this.#confirmed?.revision ?? -1) === startRevision) {
					this.error = error instanceof Error ? error.message : 'Failed to load preambles';
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
		this.invalidationVersion += 1;
		if (!this.snapshot && this.status === 'idle') return Promise.resolve();
		return untrack(() => this.#refreshLoop.request());
	}

	async create(definition: PreambleDefinitionInput): Promise<PreamblesSnapshot> {
		const current = this.#confirmed ?? (await this.ensureLoaded());
		try {
			const create = this.deps.create ?? createPreamble;
			const result = await create({
				expectedRevision: current.revision,
				preamble: definition,
			});
			return this.applySnapshot(result.snapshot);
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
		if (!this.#confirmed) await this.ensureLoaded();
		try {
			const update = this.deps.update ?? updatePreamble;
			const result = await update({
				expectedRevision,
				id,
				preamble: definition,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	async remove(id: string, expectedRevision: number): Promise<PreamblesSnapshot> {
		if (!this.#confirmed) await this.ensureLoaded();
		try {
			const remove = this.deps.remove ?? removePreamble;
			const result = await remove({
				expectedRevision,
				id,
			});
			return this.applySnapshot(result.snapshot);
		} catch (error) {
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	move(id: string, direction: 'up' | 'down'): Promise<void> {
		const run = this.#moveQueue.then(() => this.#runMove(id, direction));
		this.#moveQueue = run.catch(() => undefined);
		return run;
	}

	async #runMove(id: string, direction: 'up' | 'down'): Promise<void> {
		if (!this.#confirmed) await this.ensureLoaded();
		const current = this.#confirmed;
		if (!current) return;
		const index = current.preambles.findIndex((preamble) => preamble.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= current.preambles.length) return;
		const preambles = [...current.preambles];
		[preambles[index], preambles[target]] = [preambles[target], preambles[index]];
		this.snapshot = { ...current, preambles };
		try {
			const reorder = this.deps.reorder ?? reorderPreambles;
			const result = await reorder({
				expectedRevision: current.revision,
				orderedPreambleIds: preambles.map((preamble) => preamble.id),
			});
			this.applySnapshot(result.snapshot);
		} catch (error) {
			if (this.#confirmed === current) this.snapshot = this.#confirmed;
			await this.#refreshAfterConflict(error);
			throw error;
		}
	}

	applySnapshot(next: PreamblesSnapshot): PreamblesSnapshot {
		if (this.#confirmed && next.revision < this.#confirmed.revision) {
			return this.snapshot ?? this.#confirmed;
		}
		this.snapshot = next;
		this.#confirmed = next;
		this.status = 'ready';
		this.error = null;
		return next;
	}

	async #refreshAfterConflict(error: unknown): Promise<void> {
		if (
			error instanceof ApiError &&
			(error.errorCode === PREAMBLE_ERROR_CODES.revisionConflict ||
				error.errorCode === PREAMBLE_ERROR_CODES.notFound)
		) {
			await this.refreshIfLoaded();
		}
	}
}

export function createPreamblesStore(deps?: PreamblesStoreDeps): PreamblesStore {
	return new PreamblesStore(deps);
}
