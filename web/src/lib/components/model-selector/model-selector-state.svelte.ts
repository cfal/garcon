import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import type { SessionAgentId } from '$lib/types/app';
import { getLocale } from '$lib/paraglide/runtime.js';
import type {
	FilteredModelRowsResult,
	AgentSelectorOption,
	ModelSelectorChange,
	ModelSelectorMode,
	ModelSelectorRecentOption,
	ModelSelectorRow,
	ModelSelectorValue,
	ModelSourceOption,
} from './model-selector-types';
import {
	buildAgentOptions,
	buildModelRows,
	buildModelSelectorChange,
	buildModelSources,
	currentModelValue,
	filterModelRows,
	modelDisplayLabel,
	modelSourceKeyFor,
} from './model-selector-options';

interface ModelSelectorStateOptions {
	get modelCatalog(): ModelCatalogStore;
	get value(): ModelSelectorValue;
	get mode(): ModelSelectorMode;
	get recents(): ModelSelectorRecentOption[];
	get preferRecentsOnOpen(): boolean;
	onChange: (next: ModelSelectorChange) => void | Promise<void>;
}

type ModelSelectorContentPane = 'browse' | 'recents';

interface RowsCache {
	catalogVersion: number;
	agentId: SessionAgentId;
	sourceKey: string | null;
	models: ModelOption[];
	source: ModelSourceOption | null;
	rows: ModelSelectorRow[];
}

interface SelectionView {
	agentId: SessionAgentId;
	agentLabel: string;
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
	draftAgentId = $state<SessionAgentId | null>(null);
	draftModelValue = $state<string | null>(null);
	contentPane = $state<ModelSelectorContentPane>('browse');

	readonly #options: ModelSelectorStateOptions;
	#sourcesCache = new Map<SessionAgentId, ModelSourceOption[]>();
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

	get agentOptions(): AgentSelectorOption[] {
		return buildAgentOptions(this.modelCatalog);
	}

	get recentOptions(): ModelSelectorRecentOption[] {
		if (this.mode.surface !== 'composer' || this.mode.agent !== 'select') return [];
		return this.#options.recents;
	}

	get isRecentsPaneActive(): boolean {
		return this.contentPane === 'recents';
	}

	get shouldStartFromRecentsOnOpen(): boolean {
		return this.#options.preferRecentsOnOpen && this.recentOptions.length > 1;
	}

	isRecentSelected(recent: ModelSelectorRecentOption): boolean {
		const selectedModel = this.selectedModel;
		return (
			recent.agentId === this.agentId &&
			recent.modelValue === this.currentModelValue &&
			recent.apiProviderId === (selectedModel?.apiProviderId ?? null) &&
			recent.modelEndpointId === (selectedModel?.endpointId ?? null) &&
			recent.modelProtocol === (selectedModel?.protocol ?? null)
		);
	}

	get agentId(): SessionAgentId {
		return this.draftSelection.agentId;
	}

	get agentLabel(): string {
		return this.draftSelection.agentLabel;
	}

	get sources(): ModelSourceOption[] {
		return this.sourcesFor(this.agentId);
	}

	sourcesFor(agentId: SessionAgentId): ModelSourceOption[] {
		const catalogVersion = this.modelCatalog.version ?? 0;
		const locale = getLocale();
		if (this.#sourcesCacheVersion !== catalogVersion || this.#sourcesCacheLocale !== locale) {
			this.#sourcesCache.clear();
			this.#sourcesCacheVersion = catalogVersion;
			this.#sourcesCacheLocale = locale;
		}

		const cached = this.#sourcesCache.get(agentId);
		if (cached) return cached;

		const sources = buildModelSources(this.modelCatalog, agentId);
		this.#sourcesCache.set(agentId, sources);
		return sources;
	}

	#sourceKeyForModel(
		agentId: SessionAgentId,
		modelValue: string,
		modelEndpointId?: string | null,
	): string | null {
		const selectedModel = this.modelCatalog.getModelForSelection(
			agentId,
			modelValue,
			modelEndpointId,
		);
		if (selectedModel) return modelSourceKeyFor(agentId, selectedModel);
		return this.sourcesFor(agentId)[0]?.key ?? null;
	}

	get sourceKey(): string | null {
		return this.draftSelection.sourceKey;
	}

	get source(): ModelSourceOption | null {
		return this.draftSelection.source;
	}

	get availableModels(): ModelOption[] {
		if (this.mode.source === 'hidden') return this.modelCatalog.getModels(this.agentId);
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
		const cacheKey = this.#rowsCacheKey(this.agentId, sourceKey, source);
		const cached = this.#rowsCache.get(cacheKey);

		if (
			cached &&
			cached.catalogVersion === catalogVersion &&
			cached.agentId === this.agentId &&
			cached.sourceKey === sourceKey &&
			cached.models === models &&
			cached.source === source
		) {
			return cached.rows;
		}

		const rows = buildModelRows(models, source);
		this.#rowsCache.set(cacheKey, {
			catalogVersion,
			agentId: this.agentId,
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
		if (this.mode.surface === 'settings') return committed.agentLabel;
		if (this.mode.agent === 'select') return committed.agentLabel;
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
		if (this.mode.agent === 'select') return committed.modelLabel;
		return '';
	}

	get triggerTitle(): string {
		const committed = this.committedSelection;
		return [
			committed.agentLabel,
			this.mode.source === 'select' ? committed.source?.label : '',
			committed.modelLabel,
		]
			.filter(Boolean)
			.join(' / ');
	}

	get draftSelection(): SelectionView {
		const agentId = this.open && this.draftAgentId ? this.draftAgentId : this.value.agentId;
		const modelValue =
			this.open && this.draftModelValue !== null
				? this.draftModelValue
				: this.open
					? ''
					: currentModelValue(this.modelCatalog, this.value);
		return this.#selectionView({
			agentId,
			modelValue,
			modelEndpointId: this.open ? null : this.value.modelEndpointId,
			sourceKey: this.activeSourceKey,
		});
	}

	get committedSelection(): SelectionView {
		return this.#selectionView({
			agentId: this.value.agentId,
			modelValue: currentModelValue(this.modelCatalog, this.value),
			modelEndpointId: this.value.modelEndpointId,
			sourceKey: null,
		});
	}

	openDraft(): void {
		if (this.open) return;
		this.open = true;
		this.query = '';
		this.contentPane = this.shouldStartFromRecentsOnOpen ? 'recents' : 'browse';
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
		this.contentPane = 'browse';
		this.#clearDraft();
	}

	showRecentsPane(): void {
		if (this.recentOptions.length === 0) return;
		this.query = '';
		this.contentPane = 'recents';
	}

	showBrowsePane(): void {
		this.contentPane = 'browse';
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

	selectAgent(agentId: SessionAgentId): void {
		this.showBrowsePane();
		if (agentId === this.agentId) return;
		const sources = this.sourcesFor(agentId);
		const currentSourceKey = this.sourceKey;
		const source = sources.find((entry) => entry.key === currentSourceKey) ?? sources[0] ?? null;
		const modelValue = this.#committedModelValueFor(agentId, source?.key ?? null);
		this.query = '';
		this.#setDraftSelection(agentId, modelValue, source?.key ?? null);
		this.resetActiveModelIndex();
	}

	selectSource(sourceKey: string): void {
		this.showBrowsePane();
		if (sourceKey === this.sourceKey) return;
		const source = this.sources.find((entry) => entry.key === sourceKey) ?? null;
		const modelValue = this.#committedModelValueFor(this.agentId, source?.key ?? null);
		this.query = '';
		this.#setDraftSelection(this.agentId, modelValue, source?.key ?? null);
		this.resetActiveModelIndex();
	}

	selectModel(modelValue: string): void {
		this.showBrowsePane();
		this.#setDraftSelection(this.agentId, modelValue, this.sourceKey);
		this.resetActiveModelIndex();
		this.#commitDraftSelection();
		this.#finishClose();
	}

	selectRecent(recent: ModelSelectorRecentOption): void {
		void this.#options.onChange({
			agentId: recent.agentId,
			modelValue: recent.modelValue,
			model: recent.model,
			apiProviderId: recent.apiProviderId,
			modelEndpointId: recent.modelEndpointId,
			modelProtocol: recent.modelProtocol,
		});
		this.#finishClose();
	}

	emit(agentId: SessionAgentId, modelValue: string): void {
		const next = buildModelSelectorChange(this.modelCatalog, agentId, modelValue);
		if (!next) return;
		void this.#options.onChange(next);
	}

	#commitDraftSelection(): void {
		if (!this.draftAgentId || this.draftModelValue === null || !this.draftModelValue) return;
		const committedModelValue = currentModelValue(this.modelCatalog, this.value);
		if (this.draftAgentId === this.value.agentId && this.draftModelValue === committedModelValue) {
			return;
		}
		this.emit(this.draftAgentId, this.draftModelValue);
	}

	#startDraftFromValue(): void {
		const agentId = this.value.agentId;
		const modelValue = currentModelValue(this.modelCatalog, this.value);
		this.#setDraftSelection(
			agentId,
			modelValue,
			this.#sourceKeyForModel(agentId, modelValue, this.value.modelEndpointId),
		);
	}

	#setDraftSelection(
		agentId: SessionAgentId,
		modelValue: string | null,
		sourceKey: string | null,
	): void {
		this.draftAgentId = agentId;
		this.draftModelValue = modelValue;
		this.activeSourceKey = sourceKey;
	}

	#committedModelValueFor(agentId: SessionAgentId, sourceKey: string | null): string | null {
		if (agentId !== this.value.agentId) return null;
		const modelValue = currentModelValue(this.modelCatalog, this.value);
		if (!modelValue) return null;
		const selectedModel = this.modelCatalog.getModelForSelection(
			agentId,
			modelValue,
			this.value.modelEndpointId,
		);
		if (!selectedModel) return null;
		if (this.mode.source === 'hidden') return modelValue;
		if (!sourceKey) return null;
		return modelSourceKeyFor(agentId, selectedModel) === sourceKey ? modelValue : null;
	}

	#clearDraft(): void {
		this.draftAgentId = null;
		this.draftModelValue = null;
		this.activeSourceKey = null;
	}

	#selectionView(input: {
		agentId: SessionAgentId;
		modelValue: string;
		modelEndpointId?: string | null;
		sourceKey?: string | null;
	}): SelectionView {
		const agentLabel = this.modelCatalog.getAgentLabel(input.agentId);
		const sources = this.sourcesFor(input.agentId);
		let sourceKey: string | null = null;
		if (this.mode.source !== 'hidden') {
			sourceKey =
				input.sourceKey && sources.some((source) => source.key === input.sourceKey)
					? input.sourceKey
					: this.#sourceKeyForModel(input.agentId, input.modelValue, input.modelEndpointId);
		}
		const source = sourceKey ? (sources.find((entry) => entry.key === sourceKey) ?? null) : null;
		const selectedModel = this.modelCatalog.getModelForSelection(
			input.agentId,
			input.modelValue,
			input.modelEndpointId,
		);
		const modelLabelSource = this.mode.source === 'select' ? source : null;
		const modelLabel = modelDisplayLabel(selectedModel, input.modelValue, modelLabelSource);
		return {
			agentId: input.agentId,
			agentLabel,
			modelValue: input.modelValue,
			sourceKey,
			source,
			selectedModel,
			modelLabelSource,
			modelLabel,
		};
	}

	#rowsCacheKey(
		agentId: SessionAgentId,
		sourceKey: string | null,
		source: ModelSourceOption | null,
	): string {
		return `${agentId}:${source ? 'source' : 'flat'}:${sourceKey ?? 'all'}`;
	}
}
