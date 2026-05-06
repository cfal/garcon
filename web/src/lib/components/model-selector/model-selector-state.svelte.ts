import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import type { SessionProvider } from '$lib/types/app';
import { getLocale } from '$lib/paraglide/runtime.js';
import type {
	FilteredModelRowsResult,
	HarnessSelectorOption,
	ModelSelectorChange,
	ModelSelectorMode,
	ModelSelectorRow,
	ModelSelectorValue,
	ModelSourceOption,
} from './model-selector-types';
import {
	buildHarnessOptions,
	buildModelRows,
	buildModelSelectorChange,
	buildModelSources,
	chooseModelForSource,
	currentModelValue,
	filterModelRows,
	modelDisplayLabel,
	modelSourceKeyFor,
} from './model-selector-options';

interface ModelSelectorStateOptions {
	get modelCatalog(): ModelCatalogStore;
	get value(): ModelSelectorValue;
	get mode(): ModelSelectorMode;
	onChange: (next: ModelSelectorChange) => void | Promise<void>;
}

interface RowsCache {
	catalogVersion: number;
	harnessId: SessionProvider;
	sourceKey: string | null;
	models: ModelOption[];
	source: ModelSourceOption | null;
	rows: ModelSelectorRow[];
}

interface SelectionView {
	harnessId: SessionProvider;
	harnessLabel: string;
	modelValue: string;
	sourceKey: string | null;
	source: ModelSourceOption | null;
	selectedModel: ModelOption | null;
	modelLabelSource: ModelSourceOption | null;
	modelLabel: string;
}

let nextModelSelectorInstanceId = 0;

export class ModelSelectorState {
	readonly instanceId = nextModelSelectorInstanceId++;

	open = $state(false);
	query = $state('');
	activeSourceKey = $state<string | null>(null);
	activeModelIndex = $state(0);
	rememberedModels = $state<Record<string, string>>({});
	draftHarnessId = $state<SessionProvider | null>(null);
	draftModelValue = $state<string | null>(null);

	readonly #options: ModelSelectorStateOptions;
	#sourcesCache = new Map<SessionProvider, ModelSourceOption[]>();
	#sourcesCacheVersion: number | null = null;
	#sourcesCacheLocale: string | null = null;
	#rowsCache = new Map<string, RowsCache>();
	#rowsCacheVersion: number | null = null;
	#rowsCacheLocale: string | null = null;
	#filterCache = new WeakMap<ModelSelectorRow[], Map<string, FilteredModelRowsResult>>();

	constructor(options: ModelSelectorStateOptions) {
		this.#options = options;
	}

	get mode(): ModelSelectorMode {
		return this.#options.mode;
	}

	get value(): ModelSelectorValue {
		return this.#options.value;
	}

	get modelCatalog(): ModelCatalogStore {
		return this.#options.modelCatalog;
	}

	get harnessOptions(): HarnessSelectorOption[] {
		return buildHarnessOptions(this.modelCatalog);
	}

	get harnessId(): SessionProvider {
		return this.draftSelection.harnessId;
	}

	get harnessLabel(): string {
		return this.draftSelection.harnessLabel;
	}

	get sources(): ModelSourceOption[] {
		return this.sourcesFor(this.harnessId);
	}

	sourcesFor(harnessId: SessionProvider): ModelSourceOption[] {
		const catalogVersion = this.modelCatalog.version ?? 0;
		const locale = getLocale();
		if (this.#sourcesCacheVersion !== catalogVersion || this.#sourcesCacheLocale !== locale) {
			this.#sourcesCache.clear();
			this.#sourcesCacheVersion = catalogVersion;
			this.#sourcesCacheLocale = locale;
		}

		const cached = this.#sourcesCache.get(harnessId);
		if (cached) return cached;

		const sources = buildModelSources(this.modelCatalog, harnessId);
		this.#sourcesCache.set(harnessId, sources);
		return sources;
	}

	#sourceKeyForModel(
		harnessId: SessionProvider,
		modelValue: string,
		modelEndpointId?: string | null,
	): string | null {
		const selectedModel = this.modelCatalog.getModelForSelection(harnessId, modelValue, modelEndpointId);
		if (selectedModel) return modelSourceKeyFor(harnessId, selectedModel);
		return this.sourcesFor(harnessId)[0]?.key ?? null;
	}

	get sourceKey(): string | null {
		return this.draftSelection.sourceKey;
	}

	get source(): ModelSourceOption | null {
		return this.draftSelection.source;
	}

	get availableModels(): ModelOption[] {
		if (this.mode.source === 'hidden') return this.modelCatalog.getModels(this.harnessId);
		return this.source?.models ?? [];
	}

	get currentModelValue(): string {
		return this.draftSelection.modelValue;
	}

	get selectedModel(): ModelOption | null {
		return this.draftSelection.selectedModel;
	}

	get selectedModelLabel(): string {
		return this.draftSelection.modelLabel;
	}

	get modelRows(): ModelSelectorRow[] {
		const catalogVersion = this.modelCatalog.version ?? 0;
		const locale = getLocale();
		if (this.#rowsCacheVersion !== catalogVersion || this.#rowsCacheLocale !== locale) {
			this.#rowsCache.clear();
			this.#rowsCacheVersion = catalogVersion;
			this.#rowsCacheLocale = locale;
		}

		const models = this.availableModels;
		const source = this.modelLabelSource;
		const sourceKey = this.sourceKey;
		const cacheKey = this.#rowsCacheKey(this.harnessId, sourceKey, source);
		const cached = this.#rowsCache.get(cacheKey);

		if (
			cached &&
			cached.catalogVersion === catalogVersion &&
			cached.harnessId === this.harnessId &&
			cached.sourceKey === sourceKey &&
			cached.models === models &&
			cached.source === source
		) {
			return cached.rows;
		}

		const rows = buildModelRows(models, source);
		this.#rowsCache.set(cacheKey, {
			catalogVersion,
			harnessId: this.harnessId,
			sourceKey,
			models,
			source,
			rows,
		});
		return rows;
	}

	get filteredModelRows(): FilteredModelRowsResult {
		const rows = this.modelRows;
		const query = this.query;
		const cachedByQuery = this.#filterCache.get(rows);
		const cached = cachedByQuery?.get(query);
		if (cached) {
			return cached;
		}

		const result = filterModelRows(rows, query);
		const nextByQuery = cachedByQuery ?? new Map<string, FilteredModelRowsResult>();
		nextByQuery.set(query, result);
		this.#filterCache.set(rows, nextByQuery);
		return result;
	}

	get activeModelRow(): ModelSelectorRow | null {
		return this.filteredModelRows.items[this.activeModelIndex] ?? null;
	}

	get modelLabelSource(): ModelSourceOption | null {
		return this.draftSelection.modelLabelSource;
	}

	get triggerPrimary(): string {
		const committed = this.committedSelection;
		if (this.mode.surface === 'settings') return committed.harnessLabel;
		if (this.mode.harness === 'select') return committed.harnessLabel;
		return committed.modelLabel;
	}

	get triggerSecondary(): string {
		const committed = this.committedSelection;
		if (this.mode.surface === 'settings') {
			if (this.mode.source === 'select' && committed.source) {
				return [committed.source.label, committed.modelLabel].filter(Boolean).join(' / ');
			}
			return committed.modelLabel;
		}
		if (this.mode.harness === 'select') return committed.modelLabel;
		return '';
	}

	get triggerTitle(): string {
		const committed = this.committedSelection;
		return [
			committed.harnessLabel,
			this.mode.source === 'select' ? committed.source?.label : '',
			committed.modelLabel,
		].filter(Boolean).join(' / ');
	}

	get draftSelection(): SelectionView {
		const harnessId = this.open && this.draftHarnessId ? this.draftHarnessId : this.value.harnessId;
		const modelValue = this.open && this.draftModelValue !== null
			? this.draftModelValue
			: currentModelValue(this.modelCatalog, this.value);
		return this.#selectionView({
			harnessId,
			modelValue,
			modelEndpointId: this.open ? null : this.value.modelEndpointId,
			sourceKey: this.activeSourceKey,
		});
	}

	get committedSelection(): SelectionView {
		return this.#selectionView({
			harnessId: this.value.harnessId,
			modelValue: currentModelValue(this.modelCatalog, this.value),
			modelEndpointId: this.value.modelEndpointId,
			sourceKey: null,
		});
	}

	openDraft(): void {
		if (this.open) return;
		this.open = true;
		this.query = '';
		this.#startDraftFromValue();
		this.resetActiveModelIndex();
	}

	commitAndClose(): void {
		if (!this.open) return;
		this.#commitDraftSelection();
		this.#finishClose();
	}

	discardAndClose(): void {
		if (!this.open) return;
		this.#finishClose();
	}

	#finishClose(): void {
		this.open = false;
		this.query = '';
		this.activeModelIndex = 0;
		this.#clearDraft();
	}

	setQuery(query: string): void {
		this.query = query;
		this.resetActiveModelIndex();
	}

	resetActiveModelIndex(): void {
		const rows = this.filteredModelRows.items;
		const selectedIndex = rows.findIndex((row) => row.value === this.currentModelValue);
		this.activeModelIndex = selectedIndex >= 0 ? selectedIndex : 0;
	}

	clampActiveModelIndex(): void {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) {
			this.activeModelIndex = 0;
			return;
		}
		this.activeModelIndex = Math.min(Math.max(this.activeModelIndex, 0), rows.length - 1);
	}

	moveActiveModel(delta: number): void {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) return;
		this.activeModelIndex = Math.min(Math.max(this.activeModelIndex + delta, 0), rows.length - 1);
	}

	setActiveModelIndex(index: number): void {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) {
			this.activeModelIndex = 0;
			return;
		}
		this.activeModelIndex = Math.min(Math.max(index, 0), rows.length - 1);
	}

	handleModelKeydown(event: KeyboardEvent, visiblePageSize: number): boolean {
		const rows = this.filteredModelRows.items;
		if (rows.length === 0) return false;

		if (event.key === 'ArrowDown') {
			this.moveActiveModel(1);
			return true;
		}
		if (event.key === 'ArrowUp') {
			this.moveActiveModel(-1);
			return true;
		}
		if (event.key === 'Home') {
			this.setActiveModelIndex(0);
			return true;
		}
		if (event.key === 'End') {
			this.setActiveModelIndex(rows.length - 1);
			return true;
		}
		if (event.key === 'PageDown') {
			this.moveActiveModel(Math.max(1, visiblePageSize - 1));
			return true;
		}
		if (event.key === 'PageUp') {
			this.moveActiveModel(-Math.max(1, visiblePageSize - 1));
			return true;
		}
		if (event.key === 'Enter') {
			const row = this.activeModelRow;
			if (row) this.selectModel(row.value);
			return true;
		}

		return false;
	}

	selectHarness(harnessId: SessionProvider): void {
		if (harnessId === this.harnessId) return;
		const sources = this.sourcesFor(harnessId);
		const currentSourceKey = this.sourceKey;
		const source = sources.find((entry) => entry.key === currentSourceKey) ?? sources[0] ?? null;
		const modelValue = chooseModelForSource(
			source,
			this.currentModelValue,
			source ? this.rememberedModels[this.memoryKey(harnessId, source.key)] : undefined,
		);
		this.query = '';
		this.#setDraftSelection(harnessId, modelValue, source?.key ?? null);
		this.resetActiveModelIndex();
	}

	selectSource(sourceKey: string): void {
		if (sourceKey === this.sourceKey) return;
		const source = this.sources.find((entry) => entry.key === sourceKey) ?? null;
		const modelValue = chooseModelForSource(
			source,
			this.currentModelValue,
			source ? this.rememberedModels[this.memoryKey(this.harnessId, source.key)] : undefined,
		);
		this.query = '';
		this.#setDraftSelection(this.harnessId, modelValue, source?.key ?? null);
		this.resetActiveModelIndex();
	}

	selectModel(modelValue: string): void {
		this.#setDraftSelection(this.harnessId, modelValue, this.sourceKey);
		this.rememberSelection(this.harnessId, modelValue);
		this.resetActiveModelIndex();
	}

	rememberSelection(harnessId: SessionProvider, modelValue: string): void {
		const model = this.modelCatalog.getModelForSelection(harnessId, modelValue);
		if (!model) return;
		const sourceKey = modelSourceKeyFor(harnessId, model);
		this.rememberedModels = {
			...this.rememberedModels,
			[this.memoryKey(harnessId, sourceKey)]: modelValue,
		};
	}

	memoryKey(harnessId: SessionProvider, sourceKey: string): string {
		return `${harnessId}:${sourceKey}`;
	}

	emit(harnessId: SessionProvider, modelValue: string): void {
		const next = buildModelSelectorChange(this.modelCatalog, harnessId, modelValue);
		if (!next) return;
		this.rememberSelection(harnessId, next.modelValue);
		void this.#options.onChange(next);
	}

	#commitDraftSelection(): void {
		if (!this.draftHarnessId || this.draftModelValue === null || !this.draftModelValue) return;
		const committedModelValue = currentModelValue(this.modelCatalog, this.value);
		if (this.draftHarnessId === this.value.harnessId && this.draftModelValue === committedModelValue) {
			return;
		}
		this.emit(this.draftHarnessId, this.draftModelValue);
	}

	#startDraftFromValue(): void {
		const harnessId = this.value.harnessId;
		const modelValue = currentModelValue(this.modelCatalog, this.value);
		this.#setDraftSelection(
			harnessId,
			modelValue,
			this.#sourceKeyForModel(harnessId, modelValue, this.value.modelEndpointId),
		);
	}

	#setDraftSelection(
		harnessId: SessionProvider,
		modelValue: string,
		sourceKey: string | null,
	): void {
		this.draftHarnessId = harnessId;
		this.draftModelValue = modelValue;
		this.activeSourceKey = sourceKey;
	}

	#clearDraft(): void {
		this.draftHarnessId = null;
		this.draftModelValue = null;
		this.activeSourceKey = null;
	}

	#selectionView(input: {
		harnessId: SessionProvider;
		modelValue: string;
		modelEndpointId?: string | null;
		sourceKey?: string | null;
	}): SelectionView {
		const harnessLabel = this.modelCatalog.getHarnessLabel(input.harnessId);
		const sources = this.sourcesFor(input.harnessId);
		let sourceKey: string | null = null;
		if (this.mode.source !== 'hidden') {
			sourceKey = input.sourceKey && sources.some((source) => source.key === input.sourceKey)
				? input.sourceKey
				: this.#sourceKeyForModel(input.harnessId, input.modelValue, input.modelEndpointId);
		}
		const source = sourceKey ? sources.find((entry) => entry.key === sourceKey) ?? null : null;
		const selectedModel = this.modelCatalog.getModelForSelection(
			input.harnessId,
			input.modelValue,
			input.modelEndpointId,
		);
		const modelLabelSource = this.mode.source === 'select' ? source : null;
		const modelLabel = modelDisplayLabel(selectedModel, input.modelValue, modelLabelSource);
		return {
			harnessId: input.harnessId,
			harnessLabel,
			modelValue: input.modelValue,
			sourceKey,
			source,
			selectedModel,
			modelLabelSource,
			modelLabel,
		};
	}

	#rowsCacheKey(
		harnessId: SessionProvider,
		sourceKey: string | null,
		source: ModelSourceOption | null,
	): string {
		return `${harnessId}:${source ? 'source' : 'flat'}:${sourceKey ?? 'all'}`;
	}
}
