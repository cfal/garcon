<script lang="ts">
	import ModelSelectorPopover from '../ModelSelectorPopover.svelte';
	import { setModelCatalog } from '$lib/context';
	import type { ModelCatalogStore, ModelOption } from '$lib/agents/model-catalog-store.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorRecentOption,
		ModelSelectorValue,
	} from '../model-selector-types';

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void;
		modelCount?: number;
		includeDuplicateModel?: boolean;
		includeEndpointModel?: boolean;
		includeManagedAgent?: boolean;
		recents?: ModelSelectorRecentOption[];
		preferRecentsOnOpen?: boolean;
	}

	let {
		value,
		mode,
		onChange,
		modelCount = 120,
		includeDuplicateModel = true,
		includeEndpointModel = false,
		includeManagedAgent = false,
		recents = [],
		preferRecentsOnOpen = false,
	}: Props = $props();

	let claudeModels = $derived.by<ModelOption[]>(() => {
		const generated = Array.from(
			{ length: modelCount },
			(_, index): ModelOption => ({
				value: `model-${index}`,
				label: `Model ${index}`,
			}),
		);
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
		Array.from(
			{ length: modelCount },
			(_, index): ModelOption => ({
				value: `codex-model-${index}`,
				label: `Codex Model ${index}`,
			}),
		),
	);
	let ampModels = $derived<ModelOption[]>([{ value: 'amp-smart', label: 'Amp Smart' }]);
	let selectableAgents = $derived(
		includeManagedAgent ? ['claude', 'codex', 'amp'] : ['claude', 'codex'],
	);

	function modelsFor(agentId: string): ModelOption[] {
		if (agentId === 'amp') return ampModels;
		return agentId === 'codex' ? codexModels : claudeModels;
	}

	setModelCatalog({
		getSelectableAgents: () => selectableAgents,
		getAgent: (agentId: string) => ({
			id: agentId,
			label: agentId === 'codex' ? 'Codex' : agentId === 'amp' ? 'Amp' : 'Claude',
				description: '',
				supportsFork: agentId !== 'amp',
				supportsUpdateProjectPath: agentId !== 'amp',
				supportsImages: agentId !== 'amp',
			acceptsApiProviderEndpoints: agentId !== 'amp',
			supportedProtocols:
				agentId === 'amp'
					? []
					: agentId === 'codex'
						? ['openai-compatible']
						: ['anthropic-messages'],
			defaultModel:
				agentId === 'codex' ? 'codex-model-0' : agentId === 'amp' ? 'amp-smart' : 'model-0',
		}),
		getAgentLabel: (agentId: string) =>
			agentId === 'codex' ? 'Codex' : agentId === 'amp' ? 'Amp' : 'Claude',
		getModels: (agentId: string) => modelsFor(agentId),
		getDefaultModel: (agentId: string) => modelsFor(agentId)[0]?.value ?? '',
		getModelForSelection: (agentId: string, model: string, endpointId?: string | null) =>
			modelsFor(agentId).find(
				(entry) =>
					(endpointId ? entry.endpointId === endpointId : true) &&
					(entry.value === model || entry.rawModel === model),
			) ?? null,
		selectionFor: (agentId: string, model: string) => {
			const selected = modelsFor(agentId).find(
				(entry) => entry.value === model || entry.rawModel === model,
			);
			return {
				model: selected?.rawModel ?? model,
				apiProviderId: selected?.apiProviderId ?? null,
				modelEndpointId: selected?.endpointId ?? null,
				modelProtocol: selected?.protocol ?? null,
			};
		},
		selectionValueFor: (agentId: string, model: string, endpointId?: string | null) => {
			const selected = modelsFor(agentId).find(
				(entry) =>
					(endpointId ? entry.endpointId === endpointId : true) &&
					(entry.value === model || entry.rawModel === model),
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

<ModelSelectorPopover {value} {mode} {onChange} {recents} {preferRecentsOnOpen} />
