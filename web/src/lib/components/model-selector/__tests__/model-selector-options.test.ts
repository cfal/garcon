import { describe, expect, it } from 'vitest';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import {
	buildAgentOptions,
	buildModelRows,
	buildModelSelectorChange,
	buildModelSources,
	filterModelOptions,
	filterModelRows,
	modelDisplayLabel,
	nativeSourceLabel,
	selectedSourceKey,
	shouldShowSourceLabelForAgent,
	shouldShowSourcePickerForAgent,
} from '../model-selector-options';

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

function makeNativeOnlyCatalog(
	agentId: string,
	agentLabel: string,
	models: ModelOption[],
): ModelCatalogStore {
	return {
		getModels: (id: string) => (id === agentId ? models : []),
		getAgentLabel: (id: string) => (id === agentId ? agentLabel : id),
	} as unknown as ModelCatalogStore;
}

function makeCatalog(options: { multiEndpointProvider?: boolean } = {}): ModelCatalogStore {
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
			supportsFork: true,
			supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: id === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
			defaultModel: id === 'codex' ? 'gpt-5.5' : 'opus',
		}),
		getAgentLabel: (id: string) => (id === 'codex' ? 'Codex' : 'Claude'),
		getModels: (agentId: string) => modelsByAgent[agentId] ?? [],
		getDefaultModel: (agentId: string) => modelsByAgent[agentId]?.[0]?.value ?? '',
		getModelForSelection: (agentId: string, model: string, endpointId?: string | null) => {
			const models = modelsByAgent[agentId] ?? [];
			if (endpointId) {
				const selected = models.find(
					(entry) =>
						entry.endpointId === endpointId && (entry.value === model || entry.rawModel === model),
				);
				if (selected) return selected;
			}
			return models.find((entry) => entry.value === model || entry.rawModel === model) ?? null;
		},
		selectionFor: (agentId: string, model: string) => {
			const selected = (modelsByAgent[agentId] ?? []).find(
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
			const selected = (modelsByAgent[agentId] ?? []).find(
				(entry) =>
					(endpointId ? entry.endpointId === endpointId : true) &&
					(entry.value === model || entry.rawModel === model),
			);
			return selected?.value ?? model;
		},
		findEndpoint: (endpointId: string) => {
			if (endpointId === 'acme-anthropic') {
				return {
					apiProvider: {
						id: 'acme',
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
	} as unknown as ModelCatalogStore;
}

function makeLargeEndpointCatalog(count: number): ModelCatalogStore {
	const models = Array.from(
		{ length: count },
		(_, index): ModelOption => ({
			value: `acme-openai:model-${index}`,
			label: `Acme: Model ${index}`,
			rawModel: `model-${index}`,
			apiProviderId: 'acme',
			endpointId: 'acme-openai',
			protocol: 'openai-compatible',
		}),
	);

	return {
		getModels: () => models,
		getAgentLabel: () => 'Direct (Responses)',
		findEndpoint: () => ({
			apiProvider: {
				id: 'acme',
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
	} as unknown as ModelCatalogStore;
}

describe('model selector options', () => {
	it('labels native OAuth sources by product identity', () => {
		const catalog = makeCatalog();

		expect(nativeSourceLabel('claude', catalog)).toBe('Claude OAuth');
		expect(nativeSourceLabel('codex', catalog)).toBe('OpenAI OAuth');
	});

	it('uses catalog display labels instead of raw cached metadata for agent options', () => {
		const catalog = makeCatalog();

		expect(buildAgentOptions(catalog).map((option) => option.label)).toEqual(['Claude', 'Codex']);
	});

	it('groups native and endpoint-backed models into source options', () => {
		const sources = buildModelSources(makeCatalog(), 'claude');

		expect(sources.map((source) => source.label)).toEqual(['Claude OAuth', 'Acme']);
		expect(sources[1].models.map((model) => model.value)).toEqual(['acme-anthropic:acme-sonnet']);
		expect(sources[1].endpointId).toBe('acme-anthropic');
	});

	it('hides a single native source when it only repeats the agent label', () => {
		const catalog = makeNativeOnlyCatalog('amp', 'Amp', [
			{ value: 'amp-smart', label: 'Amp Smart' },
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

	it('resolves the selected source from raw model and endpoint metadata', () => {
		const sourceKey = selectedSourceKey(makeCatalog(), {
			agentId: 'claude',
			model: 'acme-sonnet',
			modelEndpointId: 'acme-anthropic',
		});

		expect(sourceKey).toBe('endpoint:acme-anthropic');
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

	it('filters large model lists without capping matches', () => {
		const models = Array.from({ length: 150 }, (_, index) => ({
			value: `model-${index}`,
			label: `Model ${index}`,
		}));

		const result = filterModelOptions(models, 'model');

		expect(result.items).toHaveLength(150);
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
});
