<script lang="ts">
	import ModelSelectorPopover from '../ModelSelectorPopover.svelte';
	import { setModelCatalog } from '$lib/context';
	import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorValue,
	} from '../model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void;
	}

	let { value, mode, onChange }: Props = $props();

	const models = [
		...Array.from({ length: 120 }, (_, index): ModelOption => ({
			value: `model-${index}`,
			label: `Model ${index}`,
		})),
		{ value: 'same-model', label: 'same-model' },
	];

	setModelCatalog({
		getSelectableHarnesses: () => ['claude'],
		getHarness: () => ({
			id: 'claude',
			label: 'Claude',
			description: '',
			supportsFork: true,
			supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: ['anthropic-messages'],
			defaultModel: 'model-0',
		}),
		getHarnessLabel: () => 'Claude',
		getModels: () => models,
		getDefaultModel: () => 'model-0',
		getModelForSelection: (_harnessId: string, model: string) =>
			models.find((entry) => entry.value === model || entry.rawModel === model) ?? null,
		selectionFor: (_harnessId: string, model: string) => ({
			model,
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		}),
		selectionValueFor: (_harnessId: string, model: string) => model,
		findEndpoint: () => null,
	} as unknown as ModelCatalogStore);
</script>

<ModelSelectorPopover {value} {mode} {onChange} />
