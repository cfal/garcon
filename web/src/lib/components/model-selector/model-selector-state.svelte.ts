import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import type { SessionProvider } from '$lib/types/app';
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
	findSelectedModelOption,
	modelDisplayLabel,
	selectedSourceKey,
} from './model-selector-options';

interface ModelSelectorStateOptions {
	get modelCatalog(): ModelCatalogStore;
	get value(): ModelSelectorValue;
	get mode(): ModelSelectorMode;
	onChange: (next: ModelSelectorChange) => void | Promise<void>;
}

interface SourcesCache {
	catalogVersion: number;
	harnessId: SessionProvider;
	sources: ModelSourceOption[];
}

interface RowsCache {
	catalogVersion: number;
	harnessId: SessionProvider;
	sourceKey: string | null;
	models: ModelOption[];
	source: ModelSourceOption | null;
	rows: ModelSelectorRow[];
}

interface FilterCache {
	rows: ModelSelectorRow[];
	query: string;
	result: FilteredModelRowsResult;
}

let nextModelSelectorInstanceId = 0;

export class ModelSelectorState {
	readonly instanceId = nextModelSelectorInstanceId++;

	open = $state(false);
	query = $state('');
	activeSourceKey = $state<string | null>(null);
	activeModelIndex = $state(0);
	rememberedModels = $state<Record<string, string>>({});

	readonly #options: ModelSelectorStateOptions;
	#sourcesCache: SourcesCache | null = null;
	#rowsCache: RowsCache | null = null;
	#filterCache: FilterCache | null = null;

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
		return this.value.harnessId;
	}

	get harnessLabel(): string {
		return this.modelCatalog.getHarnessLabel(this.harnessId);
	}

	get sources(): ModelSourceOption[] {
		const catalogVersion = this.modelCatalog.version;
		const cached = this.#sourcesCache;
		if (
			cached &&
			cached.catalogVersion === catalogVersion &&
			cached.harnessId === this.harnessId
		) {
			return cached.sources;
		}

		const sources = buildModelSources(this.modelCatalog, this.harnessId);
		this.#sourcesCache = {
			catalogVersion,
			harnessId: this.harnessId,
			sources,
		};
		return sources;
	}

	get sourceKey(): string | null {
		if (this.mode.source === 'hidden') return null;
		if (this.activeSourceKey && this.sources.some((source) => source.key === this.activeSourceKey)) {
			return this.activeSourceKey;
		}
		return selectedSourceKey(this.modelCatalog, this.value);
	}

	get source(): ModelSourceOption | null {
		const key = this.sourceKey;
		if (!key) return null;
		return this.sources.find((source) => source.key === key) ?? null;
	}

	get availableModels(): ModelOption[] {
		if (this.mode.source === 'hidden') return this.modelCatalog.getModels(this.harnessId);
		return this.source?.models ?? [];
	}

	get currentModelValue(): string {
		return currentModelValue(this.modelCatalog, this.value);
	}

	get selectedModel(): ModelOption | null {
		return findSelectedModelOption(this.modelCatalog, this.value);
	}

	get selectedModelLabel(): string {
		return modelDisplayLabel(this.selectedModel, this.currentModelValue, this.modelLabelSource);
	}

	get modelRows(): ModelSelectorRow[] {
		const catalogVersion = this.modelCatalog.version;
		const models = this.availableModels;
		const source = this.modelLabelSource;
		const sourceKey = this.sourceKey;
		const cached = this.#rowsCache;

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
		this.#rowsCache = {
			catalogVersion,
			harnessId: this.harnessId,
			sourceKey,
			models,
			source,
			rows,
		};
		return rows;
	}

	get filteredModelRows(): FilteredModelRowsResult {
		const rows = this.modelRows;
		const query = this.query;
		const cached = this.#filterCache;
		if (cached && cached.rows === rows && cached.query === query) {
			return cached.result;
		}

		const result = filterModelRows(rows, query);
		this.#filterCache = { rows, query, result };
		return result;
	}

	get activeModelRow(): ModelSelectorRow | null {
		return this.filteredModelRows.items[this.activeModelIndex] ?? null;
	}

	get modelLabelSource(): ModelSourceOption | null {
		return this.mode.source === 'select' ? this.source : null;
	}

	get triggerPrimary(): string {
		if (this.mode.surface === 'settings') return this.harnessLabel;
		if (this.mode.harness === 'select') return this.harnessLabel;
		return this.selectedModelLabel;
	}

	get triggerSecondary(): string {
		if (this.mode.surface === 'settings') {
			const sourceLabel = this.mode.source === 'select' && this.source ? `${this.source.label} / ` : '';
			return `${sourceLabel}${this.selectedModelLabel}`;
		}
		if (this.mode.harness === 'select') return this.selectedModelLabel;
		return '';
	}

	get triggerTitle(): string {
		const sourceLabel = this.mode.source === 'select' && this.source ? ` / ${this.source.label}` : '';
		return `${this.harnessLabel}${sourceLabel} / ${this.selectedModelLabel}`;
	}

	setOpen(open: boolean): void {
		this.open = open;
		if (open) {
			this.query = '';
			this.activeSourceKey = selectedSourceKey(this.modelCatalog, this.value);
			this.resetActiveModelIndex();
			return;
		}
		this.query = '';
		this.activeModelIndex = 0;
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
		if (event.key === 'Escape') {
			this.setOpen(false);
			return true;
		}
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
		const sources = buildModelSources(this.modelCatalog, harnessId);
		const currentSourceKey = this.sourceKey;
		const source = sources.find((entry) => entry.key === currentSourceKey) ?? sources[0] ?? null;
		const modelValue = chooseModelForSource(
			source,
			this.currentModelValue,
			source ? this.rememberedModels[this.memoryKey(harnessId, source.key)] : undefined,
		);
		this.query = '';
		this.activeSourceKey = source?.key ?? null;
		this.emit(harnessId, modelValue);
		this.activeModelIndex = 0;
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
		this.activeSourceKey = source?.key ?? null;
		this.emit(this.harnessId, modelValue);
		this.activeModelIndex = 0;
	}

	selectModel(modelValue: string): void {
		this.emit(this.harnessId, modelValue);
		this.setOpen(false);
	}

	rememberSelection(harnessId: SessionProvider, modelValue: string): void {
		const source = buildModelSources(this.modelCatalog, harnessId).find((entry) =>
			entry.models.some((model) => model.value === modelValue)
		);
		if (!source) return;
		this.rememberedModels = {
			...this.rememberedModels,
			[this.memoryKey(harnessId, source.key)]: modelValue,
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
}
