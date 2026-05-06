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
		modelCount?: number;
		includeDuplicateModel?: boolean;
		includeEndpointModel?: boolean;
	}

	let {
		value,
		mode,
		onChange,
		modelCount = 120,
		includeDuplicateModel = true,
		includeEndpointModel = false,
	}: Props = $props();

	let claudeModels = $derived.by<ModelOption[]>(() => {
		const generated = Array.from({ length: modelCount }, (_, index): ModelOption => ({
			value: `model-${index}`,
			label: `Model ${index}`,
		}));
		const withDuplicate = includeDuplicateModel
			? [...generated, { value: 'same-model', label: 'same-model' }]
			: generated;
		return includeEndpointModel
			? [
				...withDuplicate,
				{
					value: 'acme-claude:endpoint-model',
					label: 'Acme: Endpoint Model',
					rawModel: 'endpoint-model',
					apiProviderId: 'acme',
					endpointId: 'acme-claude',
					protocol: 'anthropic-messages',
				},
			]
			: withDuplicate;
	});
	let codexModels = $derived.by<ModelOption[]>(() =>
		Array.from({ length: modelCount }, (_, index): ModelOption => ({
			value: `codex-model-${index}`,
			label: `Codex Model ${index}`,
		}))
	);

	function modelsFor(harnessId: string): ModelOption[] {
		return harnessId === 'codex' ? codexModels : claudeModels;
	}

	setModelCatalog({
		getSelectableHarnesses: () => ['claude', 'codex'],
		getHarness: (harnessId: string) => ({
			id: harnessId,
			label: harnessId === 'codex' ? 'Codex' : 'Claude',
			description: '',
			supportsFork: true,
			supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: harnessId === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
			defaultModel: harnessId === 'codex' ? 'codex-model-0' : 'model-0',
		}),
		getHarnessLabel: (harnessId: string) => harnessId === 'codex' ? 'Codex' : 'Claude',
		getModels: (harnessId: string) => modelsFor(harnessId),
		getDefaultModel: (harnessId: string) => modelsFor(harnessId)[0]?.value ?? '',
		getModelForSelection: (harnessId: string, model: string, endpointId?: string | null) =>
			modelsFor(harnessId).find((entry) =>
				(endpointId ? entry.endpointId === endpointId : true) &&
				(entry.value === model || entry.rawModel === model)
			) ?? null,
		selectionFor: (harnessId: string, model: string) => {
			const selected = modelsFor(harnessId).find((entry) => entry.value === model || entry.rawModel === model);
			return {
				model: selected?.rawModel ?? model,
				apiProviderId: selected?.apiProviderId ?? null,
				modelEndpointId: selected?.endpointId ?? null,
				modelProtocol: selected?.protocol ?? null,
			};
		},
		selectionValueFor: (harnessId: string, model: string, endpointId?: string | null) => {
			const selected = modelsFor(harnessId).find((entry) =>
				(endpointId ? entry.endpointId === endpointId : true) &&
				(entry.value === model || entry.rawModel === model)
			);
			return selected?.value ?? model;
		},
		findEndpoint: (endpointId: string) => {
			if (endpointId !== 'acme-claude') return null;
			const endpoint = {
				id: 'acme-claude',
				protocol: 'anthropic-messages' as const,
				baseUrl: 'https://anthropic.example',
				defaultModel: 'endpoint-model',
				models: [],
				supportsImages: true,
				hasApiKey: true,
			};
			return {
				apiProvider: {
					id: 'acme',
					label: 'Acme',
					createdAt: '',
					updatedAt: '',
					endpoints: [endpoint],
				},
				endpoint,
			};
		},
	} as unknown as ModelCatalogStore);
</script>

<ModelSelectorPopover {value} {mode} {onChange} />
