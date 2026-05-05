import { describe, expect, it } from 'vitest';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import {
	buildModelSelectorChange,
	buildModelSources,
	filterModelOptions,
	modelDisplayLabel,
	nativeSourceLabel,
	selectedSourceKey,
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

function makeCatalog(options: { multiEndpointProvider?: boolean } = {}): ModelCatalogStore {
	const modelsByHarness: Record<string, ModelOption[]> = {
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
		getSelectableHarnesses: () => ['claude', 'codex'],
		getHarness: (id: string) => ({
			id,
			label: id === 'codex' ? 'Codex' : 'Claude',
			description: '',
			supportsFork: true,
			supportsImages: true,
			acceptsApiProviderEndpoints: true,
			supportedProtocols: id === 'codex' ? ['openai-compatible'] : ['anthropic-messages'],
			defaultModel: id === 'codex' ? 'gpt-5.5' : 'opus',
		}),
		getHarnessLabel: (id: string) => (id === 'codex' ? 'Codex' : 'Claude'),
		getModels: (harnessId: string) => modelsByHarness[harnessId] ?? [],
		getDefaultModel: (harnessId: string) => modelsByHarness[harnessId]?.[0]?.value ?? '',
		getModelForSelection: (harnessId: string, model: string, endpointId?: string | null) => {
			const models = modelsByHarness[harnessId] ?? [];
			if (endpointId) {
				const selected = models.find((entry) =>
					entry.endpointId === endpointId && (entry.value === model || entry.rawModel === model)
				);
				if (selected) return selected;
			}
			return models.find((entry) => entry.value === model || entry.rawModel === model) ?? null;
		},
		selectionFor: (harnessId: string, model: string) => {
			const selected = (modelsByHarness[harnessId] ?? []).find((entry) =>
				entry.value === model || entry.rawModel === model
			);
			return {
				model: selected?.rawModel ?? model,
				apiProviderId: selected?.apiProviderId ?? null,
				modelEndpointId: selected?.endpointId ?? null,
				modelProtocol: selected?.protocol ?? null,
			};
		},
		selectionValueFor: (harnessId: string, model: string, endpointId?: string | null) => {
			const selected = (modelsByHarness[harnessId] ?? []).find((entry) =>
				(endpointId ? entry.endpointId === endpointId : true) &&
				(entry.value === model || entry.rawModel === model)
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

describe('model selector options', () => {
	it('labels native OAuth sources by product identity', () => {
		const catalog = makeCatalog();

		expect(nativeSourceLabel('claude', catalog)).toBe('Claude OAuth');
		expect(nativeSourceLabel('codex', catalog)).toBe('OpenAI OAuth');
	});

	it('groups native and endpoint-backed models into source options', () => {
		const sources = buildModelSources(makeCatalog(), 'claude');

		expect(sources.map((source) => source.label)).toEqual(['Claude OAuth', 'Acme']);
		expect(sources[1].models.map((model) => model.value)).toEqual(['acme-anthropic:acme-sonnet']);
		expect(sources[1].endpointId).toBe('acme-anthropic');
	});

	it('disambiguates multiple endpoints under one provider source', () => {
		const sources = buildModelSources(makeCatalog({ multiEndpointProvider: true }), 'claude');

		expect(sources[1].label).toBe('Acme (Anthropic - https://anthropic.example)');
	});

	it('removes endpoint provider prefixes only when a source is visible', () => {
		const source = buildModelSources(makeCatalog(), 'claude')[1];
		const model = claudeModels[1];

		expect(modelDisplayLabel(model, model.value, source)).toBe('Sonnet');
		expect(modelDisplayLabel(model, model.value, null)).toBe('Acme: Sonnet');
	});

	it('resolves the selected source from raw model and endpoint metadata', () => {
		const sourceKey = selectedSourceKey(makeCatalog(), {
			harnessId: 'claude',
			model: 'acme-sonnet',
			modelEndpointId: 'acme-anthropic',
		});

		expect(sourceKey).toBe('endpoint:acme-anthropic');
	});

	it('preserves endpoint metadata when building selector changes', () => {
		const change = buildModelSelectorChange(makeCatalog(), 'codex', 'acme-openai:acme-gpt');

		expect(change).toEqual({
			harnessId: 'codex',
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
});
