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
			entriesDiffer: (left, right) => preamblesDiffer(left.preambles, right.preambles),
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

	reconcileAfterReconnect(): Promise<void> {
		return this.#catalog.reconcileAfterReconnect();
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
		return this.#catalog.mutate(() =>
			update({ expectedRevision, id, preamble: definition }),
		);
	}

	remove(id: string): Promise<PreamblesSnapshot> {
		const remove = this.deps.remove ?? removePreamble;
		return this.#catalog.mutate((current) =>
			remove({ expectedRevision: current.revision, id }),
		);
	}

	async move(id: string, direction: 'up' | 'down'): Promise<void> {
		const current = this.#catalog.snapshot ?? (await this.#catalog.ensureLoaded());
		const index = current.preambles.findIndex((preamble) => preamble.id === id);
		const target = direction === 'up' ? index - 1 : index + 1;
		if (index < 0 || target < 0 || target >= current.preambles.length) return;
		const preambles = [...current.preambles];
		[preambles[index], preambles[target]] = [preambles[target], preambles[index]];
		const reorder = this.deps.reorder ?? reorderPreambles;
		await this.#catalog.mutate(
			(base) =>
				reorder({
					expectedRevision: base.revision,
					orderedPreambleIds: preambles.map((preamble) => preamble.id),
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
