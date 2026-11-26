import {
	createPreamble,
	getPreambles,
	removePreamble,
	reorderPreambles,
	updatePreamble,
} from '$lib/api/preambles.js';
import {
	VersionedCatalogStore,
	type VersionedCatalogStatus,
} from '$lib/stores/versioned-catalog-store.svelte.js';
import {
	PREAMBLE_ERROR_CODES,
	type PreambleDefinitionInput,
	type PreamblesSnapshot,
} from '$shared/preambles';

export type PreamblesStatus = VersionedCatalogStatus;

export interface PreamblesStoreDeps {
	get?: typeof getPreambles;
	create?: typeof createPreamble;
	update?: typeof updatePreamble;
	remove?: typeof removePreamble;
	reorder?: typeof reorderPreambles;
}

export class PreamblesStore {
	readonly #catalog: VersionedCatalogStore<PreamblesSnapshot>;

	constructor(private readonly deps: PreamblesStoreDeps = {}) {
		this.#catalog = new VersionedCatalogStore<PreamblesSnapshot>({
			load: () => (this.deps.get ?? getPreambles)(),
			loadErrorMessage: 'Failed to load preambles',
			revisionConflictCode: PREAMBLE_ERROR_CODES.revisionConflict,
		});
	}

	get status(): PreamblesStatus {
		return this.#catalog.status;
	}

	get snapshot(): PreamblesSnapshot | null {
		return this.#catalog.snapshot;
	}

	get error(): string | null {
		return this.#catalog.error;
	}

	get isRefreshing(): boolean {
		return this.#catalog.isRefreshing;
	}

	get invalidationVersion(): number {
		return this.#catalog.invalidationVersion;
	}

	get hasLoaded(): boolean {
		return this.#catalog.hasLoaded;
	}

	get hasFreshSnapshot(): boolean {
		return this.#catalog.hasFreshSnapshot;
	}

	get preambles() {
		return this.#catalog.snapshot?.preambles ?? [];
	}

	ensureLoaded(): Promise<PreamblesSnapshot> {
		return this.#catalog.ensureLoaded();
	}

	refresh(): Promise<PreamblesSnapshot> {
		return this.#catalog.refresh();
	}

	loadInBackground(): Promise<void> {
		return this.#catalog.loadInBackground();
	}

	refreshInBackground(): Promise<void> {
		return this.#catalog.refreshInBackground();
	}

	refreshIfLoaded(): Promise<void> {
		return this.#catalog.refreshIfLoaded();
	}

	create(definition: PreambleDefinitionInput): Promise<PreamblesSnapshot> {
		const create = this.deps.create ?? createPreamble;
		return this.#catalog.mutate((current) =>
			create({ expectedRevision: current.revision, preamble: definition }),
		);
	}

	update(
		id: string,
		definition: PreambleDefinitionInput,
		expectedRevision: number,
	): Promise<PreamblesSnapshot> {
		const update = this.deps.update ?? updatePreamble;
		return this.#catalog.mutate(() => update({ expectedRevision, id, preamble: definition }));
	}

	remove(id: string, expectedRevision: number): Promise<PreamblesSnapshot> {
		const remove = this.deps.remove ?? removePreamble;
		return this.#catalog.mutate(() => remove({ expectedRevision, id }));
	}

	async move(id: string, direction: 'up' | 'down'): Promise<void> {
		const current = this.#catalog.snapshot ?? (await this.#catalog.ensureLoaded());
		const index = current.preambles.findIndex((preamble) => preamble.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= current.preambles.length) return;
		const preambles = [...current.preambles];
		[preambles[index], preambles[target]] = [preambles[target], preambles[index]];
		const orderedPreambleIds = preambles.map((preamble) => preamble.id);
		const reorder = this.deps.reorder ?? reorderPreambles;
		await this.#catalog.mutate(
			() =>
				reorder({
					expectedRevision: current.revision,
					orderedPreambleIds,
				}),
			{ preview: { ...current, preambles } },
		);
	}

	applySnapshot(next: PreamblesSnapshot): PreamblesSnapshot {
		return this.#catalog.applySnapshot(next);
	}
}

export function createPreamblesStore(deps?: PreamblesStoreDeps): PreamblesStore {
	return new PreamblesStore(deps);
}
