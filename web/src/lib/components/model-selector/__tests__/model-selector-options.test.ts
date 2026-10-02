import { describe, expect, it } from 'vitest';
import type { ModelCatalogStore, ModelOption } from '$lib/agents/model-catalog-store.svelte';
import {
	DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
	DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
} from '$shared/agents';
import {
	buildAgentGroups,
	buildModelRows,
	buildModelSelectorChange,
	buildModelSources,
	currentModelValue,
	filterModelRows,
	modelDisplayLabel,
	nativeSourceLabel,
	shouldShowSourceLabelForAgent,
	shouldShowSourcePickerForAgent,
} from '../model-selector-options';
import { modelValueForSelection, resolveModelSelection } from '../../../../test/model-catalog';

const claudeModels: ModelOption[] = [
	{ value: 'opus', label: 'Opus', supportsImages: true },
	{
		value: 'acme-anthropic:acme-sonnet',
		label: 'Acme: Sonnet',
		rawModel: 'acme-sonnet',
		apiProviderId: 'acme',
		endpointId: 'acme-anthropic',
		protocol: 'anthropic-messages',
		supportsImages: true,
	},
];

const codexModels: ModelOption[] = [
	{ value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true },
	{
		value: 'acme-openai:acme-gpt',
		label: 'Acme: GPT',
		rawModel: 'acme-gpt',
		apiProviderId: 'acme',
		endpointId: 'acme-openai',
		protocol: 'openai-compatible',
		supportsImages: true,
	},
];

function makeNativeOnlyCatalog(agentId: string, agentLabel: string, models: ModelOption[]) {
	return {
		getModels: (id: string) => (id === agentId ? models : []),
		getAgentLabel: (id: string) => (id === agentId ? agentLabel : id),
		findEndpoint: () => null,
	} satisfies Parameters<typeof buildModelSources>[0];
}

function makeCatalog(options: { multiEndpointProvider?: boolean } = {}) {
	const modelsByAgent: Record<string, ModelOption[]> = {
		claude: claudeModels,
		codex: codexModels,
	};
	const acmeAnthropicEndpoint = {
		id: 'acme-anthropic',
		protocol: 'anthropic-messages' as const,
		baseUrl: 'https://anthropic.example',
		defaultModel: 'acme-sonnet',
		models: [],
		supportsImages: true,
		hasApiKey: true,
	};
	const acmeOpenAiEndpoint = {
		id: 'acme-openai',
		protocol: 'openai-compatible' as const,
		baseUrl: 'https://openai.example',
		defaultModel: 'acme-gpt',
		models: [],
		supportsImages: true,
		hasApiKey: true,
	};
	const providerEndpoints = options.multiEndpointProvider
		? [acmeAnthropicEndpoint, acmeOpenAiEndpoint]
		: null;

	return {
		getSelectableAgents: () => ['claude', 'codex'],
		getAgent: (id: string) => ({
			id,
			label: id === 'codex' ? 'Cached Codex' : 'Cached Claude',
			description: '',
			supportsCompact: false,
			supportsFork: true,
			supportsForkAtMessage: false,
			supportsForkWhileRunning: false,
			supportsUpdateProjectPath: true,
			supportsSteering: false,
			supportsImages: true,
			fileAttachmentMimeTypes: [],
			acceptsApiProviderEndpoints: true,
			supportedProtocols: id === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
			authLoginSupported: false,
			supportedPermissionModes: [],
			supportedThinkingModes: [],
			settings: [],
			defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
			defaultModel: id === 'codex' ? 'gpt-5.5' : 'opus',
		}),
		getAgentLabel: (id: string) => (id === 'codex' ? 'Codex' : 'Claude'),
		getModels: (agentId: string) => modelsByAgent[agentId] ?? [],
		getDefaultModel: (agentId: string) => modelsByAgent[agentId]?.[0]?.value ?? '',
		selectionFor: (agentId: string, model: string) => {
			const selection = resolveModelSelection(modelsByAgent[agentId] ?? [], model);
			if (!selection) throw new Error('Missing model fixture');
			return selection;
		},
		selectionValueFor: (agentId: string, model: string, endpointId?: string | null) =>
			modelValueForSelection(modelsByAgent[agentId] ?? [], model, endpointId),
		findEndpoint: (endpointId: string) => {
			if (endpointId === 'acme-anthropic') {
				return {
					apiProvider: {
						id: 'acme',
						revision: 1,
						label: 'Acme',
						createdAt: '',
						updatedAt: '',
						endpoints: providerEndpoints ?? [acmeAnthropicEndpoint],
					},
					endpoint: acmeAnthropicEndpoint,
				};
			}
			if (endpointId === 'acme-openai') {
				return {
					apiProvider: {
						id: 'acme',
						revision: 1,
						label: 'Acme',
						createdAt: '',
						updatedAt: '',
						endpoints: providerEndpoints ?? [acmeOpenAiEndpoint],
					},
					endpoint: acmeOpenAiEndpoint,
				};
			}
			return null;
		},
	} satisfies Pick<
		ModelCatalogStore,
		| 'getSelectableAgents'
		| 'getAgent'
		| 'getAgentLabel'
		| 'getModels'
		| 'getDefaultModel'
		| 'selectionFor'
		| 'selectionValueFor'
		| 'findEndpoint'
	>;
}

function makeLargeEndpointCatalog(count: number) {
	const models = Array.from({ length: count }, (_, index): ModelOption => ({
		value: `acme-openai:model-${index}`,
		label: `Acme: Model ${index}`,
		rawModel: `model-${index}`,
		apiProviderId: 'acme',
		endpointId: 'acme-openai',
		protocol: 'openai-compatible',
	}));

	return {
		getModels: () => models,
		getAgentLabel: () => 'Direct (Responses)',
		findEndpoint: () => ({
			apiProvider: {
				id: 'acme',
				revision: 1,
				label: 'Acme',
				createdAt: '',
				updatedAt: '',
				endpoints: [
					{
						id: 'acme-openai',
						protocol: 'openai-compatible',
						baseUrl: 'https://openai.example',
						defaultModel: 'model-0',
						models: [],
						supportsImages: true,
						hasApiKey: true,
					},
				],
			},
			endpoint: {
				id: 'acme-openai',
				protocol: 'openai-compatible',
				baseUrl: 'https://openai.example',
				defaultModel: 'model-0',
				models: [],
				supportsImages: true,
				hasApiKey: true,
			},
		}),
	} satisfies Parameters<typeof buildModelSources>[0];
}

describe('model selector options', () => {
	it('labels native OAuth sources by product identity', () => {
		const catalog = makeCatalog();

		expect(nativeSourceLabel('claude', catalog)).toBe('Claude OAuth');
		expect(nativeSourceLabel('codex', catalog)).toBe('OpenAI OAuth');
	});

	it('uses catalog display labels instead of raw cached metadata for agent options', () => {
		const catalog = makeCatalog();

		expect(buildAgentGroups(catalog)[0]?.options.map((option) => option.label)).toEqual([
			'Claude',
			'Codex',
		]);
	});

	it('groups direct agents first with fixed order and short labels', () => {
		const catalog = makeCatalog();
		const groups = buildAgentGroups(catalog, [
			DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID,
			'codex',
			DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID,
			'claude',
			DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID,
		]);

		expect(groups.map((group) => group.id)).toEqual(['direct', 'agents']);
		expect(groups.map((group) => group.label)).toEqual(['Direct', 'Agents']);
		expect(groups[0]?.options.map((option) => option.label)).toEqual([
			'Chat Completions',
			'Responses',
			'Anthropic',
		]);
		expect(groups[1]?.options.map((option) => option.label)).toEqual(['Codex', 'Claude']);
	});

	it('omits empty agent groups', () => {
		const catalog = makeCatalog();

		expect(buildAgentGroups(catalog, ['claude']).map((group) => group.id)).toEqual(['agents']);
		expect(
			buildAgentGroups(catalog, [DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID]).map(
				(group) => group.id,
			),
		).toEqual(['direct']);
	});

	it('groups native and endpoint-backed models into source options', () => {
		const sources = buildModelSources(makeCatalog(), 'claude');

		expect(sources.map((source) => source.label)).toEqual(['Claude OAuth', 'Acme']);
		expect(sources[1].models.map((model) => model.value)).toEqual(['acme-anthropic:acme-sonnet']);
		expect(sources[1].endpointId).toBe('acme-anthropic');
	});

	it('hides a single native source when it only repeats the agent label', () => {
		const catalog = makeNativeOnlyCatalog('amp', 'Amp', [
			{ value: 'medium', label: 'Amp Medium' },
		]);
		const sources = buildModelSources(catalog, 'amp');

		expect(sources.map((source) => source.label)).toEqual(['Amp']);
		expect(shouldShowSourcePickerForAgent(catalog, 'amp', sources)).toBe(false);
		expect(shouldShowSourceLabelForAgent(catalog, 'amp', sources[0], sources)).toBe(false);
	});

	it('keeps a single native source visible when it carries distinct provider meaning', () => {
		const catalog = makeNativeOnlyCatalog('claude', 'Claude', [{ value: 'opus', label: 'Opus' }]);
		const sources = buildModelSources(catalog, 'claude');

		expect(sources.map((source) => source.label)).toEqual(['Claude OAuth']);
		expect(shouldShowSourcePickerForAgent(catalog, 'claude', sources)).toBe(true);
		expect(shouldShowSourceLabelForAgent(catalog, 'claude', sources[0], sources)).toBe(true);
	});

	it('disambiguates multiple endpoints under one provider source', () => {
		const sources = buildModelSources(makeCatalog({ multiEndpointProvider: true }), 'claude');

		expect(sources[1].label).toBe('Acme (Anthropic - https://anthropic.example)');
	});

	it('groups large endpoint catalogs without dropping model order', () => {
		const sources = buildModelSources(
			makeLargeEndpointCatalog(2500),
			'direct-openai-responses-compatible',
		);

		expect(sources).toHaveLength(1);
		expect(sources[0].models).toHaveLength(2500);
		expect(sources[0].models[0].value).toBe('acme-openai:model-0');
		expect(sources[0].models[2499].value).toBe('acme-openai:model-2499');
	});

	it('removes endpoint provider prefixes only when a source is visible', () => {
		const source = buildModelSources(makeCatalog(), 'claude')[1];
		const model = claudeModels[1];

		expect(modelDisplayLabel(model, model.value, source)).toBe('Sonnet');
		expect(modelDisplayLabel(model, model.value, null)).toBe('Acme: Sonnet');
	});

	it('builds model rows with one visible label', () => {
		const rows = buildModelRows([{ value: 'same-model', label: 'same-model' }], null);

		expect(rows[0].label).toBe('same-model');
		expect(rows[0].searchText).toContain('same-model');
	});

	it('builds model rows with source prefixes stripped only when source is visible', () => {
		const source = buildModelSources(makeCatalog(), 'claude')[1];
		const model = claudeModels[1];

		expect(buildModelRows([model], source)[0].label).toBe('Sonnet');
		expect(buildModelRows([model], null)[0].label).toBe('Acme: Sonnet');
	});

	it('resolves the selected value from raw model and endpoint metadata', () => {
		const modelValue = currentModelValue(makeCatalog(), {
			agentId: 'claude',
			model: 'acme-sonnet',
			modelEndpointId: 'acme-anthropic',
		});

		expect(modelValue).toBe('acme-anthropic:acme-sonnet');
	});

	it('preserves endpoint metadata when building selector changes', () => {
		const change = buildModelSelectorChange(makeCatalog(), 'codex', 'acme-openai:acme-gpt');

		expect(change).toEqual({
			agentId: 'codex',
			modelValue: 'acme-openai:acme-gpt',
			model: 'acme-gpt',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-openai',
			modelProtocol: 'openai-compatible',
		});
	});

	it('filters prepared model rows without capping matches', () => {
		const rows = buildModelRows(
			Array.from({ length: 150 }, (_, index) => ({
				value: `model-${index}`,
				label: `Model ${index}`,
			})),
			null,
		);

		const result = filterModelRows(rows, 'model');

		expect(result.items).toHaveLength(150);
	});

	it('filters prepared model rows by raw model', () => {
		const rows = buildModelRows(
			[
				{ value: 'display-a', label: 'Display A', rawModel: 'vendor/raw-a' },
				{ value: 'display-b', label: 'Display B', rawModel: 'vendor/raw-b' },
			],
			null,
		);

		const result = filterModelRows(rows, 'raw-b');

		expect(result.items.map((row) => row.value)).toEqual(['display-b']);
	});

	it('preserves row identity and ordering for an empty query', () => {
		const rows = buildModelRows(claudeModels);
		expect(filterModelRows(rows, '  ').items).toBe(rows);
	});

	it('ranks exact, prefix, substring, and compact matches with stable ties', () => {
		const rows = buildModelRows([
			{ value: 'compact', label: 'Son-net' },
			{ value: 'substring', label: 'Acme Sonnet' },
			{ value: 'prefix-first', label: 'Sonnet Large' },
			{ value: 'exact', label: 'Sonnet' },
			{ value: 'prefix-second', label: 'Sonnet Small' },
		]);
		expect(filterModelRows(rows, 'SONNET').items.map((row) => row.value)).toEqual([
			'exact',
			'prefix-first',
			'prefix-second',
			'substring',
			'compact',
		]);
	});

	it('requires every query token and searches stripped source labels', () => {
		const source = buildModelSources(makeCatalog(), 'claude')[1];
		const rows = buildModelRows(claudeModels, source);
		expect(filterModelRows(rows, '  Acme   Sonnet  ').items.map((row) => row.value)).toEqual([
			'acme-anthropic:acme-sonnet',
		]);
		expect(filterModelRows(rows, 'Acme missing').items).toEqual([]);
	});
});
