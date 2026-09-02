<script lang="ts">
	import ModelSelectorPopover from '../ModelSelectorPopover.svelte';
	import { setModelCatalog } from '$lib/context';
	import type { ModelCatalogStore, ModelOption } from '$lib/agents/model-catalog-store.svelte';
	import type { SessionAgentId } from '$lib/types/app.js';
	import {
		DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
	} from '$shared/agents';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorRecentOption,
		ModelSelectorValue,
	} from '../model-selector-types';
	import { THINKING_MODE_VALUES, type ThinkingMode } from '$shared/chat-modes';

	interface AgentFixture {
		label: string;
		models: ModelOption[];
		supportedProtocols: ('openai-compatible' | 'anthropic-messages')[];
		thinkingModes: ThinkingMode[];
	}

	interface Props {
		value: ModelSelectorValue;
		mode: ModelSelectorMode;
		onChange: (next: ModelSelectorChange) => void;
		modelCount?: number;
		includeDuplicateModel?: boolean;
		includeEndpointModel?: boolean;
		includeManagedAgent?: boolean;
		includeDirectAgents?: boolean;
		selectableAgentIds?: readonly SessionAgentId[];
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
		includeDirectAgents = false,
		selectableAgentIds,
		recents = [],
		preferRecentsOnOpen = false,
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
		})),
	);
	let agentFixtures = $derived.by<Record<string, AgentFixture>>(() => ({
		claude: {
			label: 'Claude',
			models: claudeModels,
			supportedProtocols: ['anthropic-messages'],
			thinkingModes: [...THINKING_MODE_VALUES],
		},
		codex: {
			label: 'Codex',
			models: codexModels,
			supportedProtocols: ['openai-compatible'],
			thinkingModes: [...THINKING_MODE_VALUES],
		},
		...(includeManagedAgent
			? {
					cursor: {
						label: 'Managed Agent',
						models: [{ value: 'managed-model', label: 'Managed Model' }],
						supportedProtocols: [],
						thinkingModes: ['none'],
					},
				}
			: {}),
	}));
	const directModelsByAgent: Record<string, ModelOption[]> = {
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: [
			{ value: 'chat-model', label: 'Chat Model' },
		],
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: [
			{ value: 'responses-model', label: 'Responses Model' },
		],
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: [
			{ value: 'anthropic-model', label: 'Anthropic Model' },
		],
	};
	const directLabelsByAgent: Record<string, string> = {
		[DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID]: 'Direct (Chat Completions)',
		[DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]: 'Direct (Responses)',
		[DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID]: 'Direct (Anthropic)',
	};
	let selectableAgents = $derived([
		...(includeDirectAgents
			? [
					DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
					DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
					DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
				]
			: []),
		...(includeManagedAgent ? ['claude', 'codex', 'cursor'] : ['claude', 'codex']),
	] as SessionAgentId[]);

	function modelsFor(agentId: string): ModelOption[] {
		return agentFixtures[agentId]?.models ?? directModelsByAgent[agentId] ?? [];
	}

	setModelCatalog({
		getSelectableAgents: () => selectableAgents,
		getAgent: (agentId: string) => {
			const fixture = agentFixtures[agentId];
			return fixture
				? {
						id: agentId,
						label: fixture.label,
						description: '',
						supportsFork: true,
						supportsUpdateProjectPath: true,
						supportsImages: true,
						acceptsApiProviderEndpoints: fixture.supportedProtocols.length > 0,
						supportedProtocols: fixture.supportedProtocols,
						defaultModel: fixture.models[0]?.value ?? '',
					}
				: null;
		},
		getAgentLabel: (agentId: string) =>
			agentFixtures[agentId]?.label ?? directLabelsByAgent[agentId] ?? agentId,
		getModels: (agentId: string) => modelsFor(agentId),
		getThinkingModes: (agentId: string) =>
			agentFixtures[agentId]?.thinkingModes ??
			(directLabelsByAgent[agentId] ? [...THINKING_MODE_VALUES] : []),
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

<ModelSelectorPopover
	{value}
	{mode}
	{onChange}
	{recents}
	{preferRecentsOnOpen}
	{selectableAgentIds}
/>
