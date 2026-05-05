import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import type { SessionProvider } from '$lib/types/app';
import type {
	FilteredModelResult,
	HarnessSelectorOption,
	ModelSelectorChange,
	ModelSelectorMode,
	ModelSelectorValue,
	ModelSourceOption,
} from './model-selector-types';
import {
	buildHarnessOptions,
	buildModelSelectorChange,
	buildModelSources,
	chooseModelForSource,
	currentModelValue,
	filterModelOptions,
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

export class ModelSelectorState {
	open = $state(false);
	query = $state('');
	selectedCommandValue = $state('');
	activeSourceKey = $state<string | null>(null);
	rememberedModels = $state<Record<string, string>>({});

	readonly #options: ModelSelectorStateOptions;

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
		return buildModelSources(this.modelCatalog, this.harnessId);
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

	get filteredModels(): FilteredModelResult {
		return filterModelOptions(this.availableModels, this.query, this.modelLabelSource);
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
			this.selectedCommandValue = this.currentModelValue;
			return;
		}
		this.query = '';
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
		this.activeSourceKey = source?.key ?? null;
		this.emit(harnessId, modelValue);
	}

	selectSource(sourceKey: string): void {
		if (sourceKey === this.sourceKey) return;
		const source = this.sources.find((entry) => entry.key === sourceKey) ?? null;
		const modelValue = chooseModelForSource(
			source,
			this.currentModelValue,
			source ? this.rememberedModels[this.memoryKey(this.harnessId, source.key)] : undefined,
		);
		this.activeSourceKey = source?.key ?? null;
		this.emit(this.harnessId, modelValue);
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

	modelLabel(model: ModelOption): string {
		return modelDisplayLabel(model, model.value, this.modelLabelSource);
	}

	modelSubtitle(model: ModelOption): string {
		const subtitle = model.rawModel ?? model.value;
		return subtitle.trim() === this.modelLabel(model).trim() ? '' : subtitle;
	}

	emit(harnessId: SessionProvider, modelValue: string): void {
		const next = buildModelSelectorChange(this.modelCatalog, harnessId, modelValue);
		if (!next) return;
		this.selectedCommandValue = next.modelValue;
		this.rememberSelection(harnessId, next.modelValue);
		void this.#options.onChange(next);
	}
}
