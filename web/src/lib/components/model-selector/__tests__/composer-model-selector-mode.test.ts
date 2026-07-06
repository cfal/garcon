import { describe, expect, it } from 'vitest';
import type { ModelCatalogStore, ModelOption } from '$lib/stores/model-catalog.svelte';
import { composerModelSelectorMode } from '../composer-model-selector-mode';

function makeCatalog(input: {
	agents: string[];
	models: Record<string, ModelOption[]>;
	labels?: Record<string, string>;
}): ModelCatalogStore {
	return {
		getSelectableAgents: () => input.agents,
		getModels: (id: string) => input.models[id] ?? [],
		getAgentLabel: (id: string) => input.labels?.[id] ?? id,
		findEndpoint: () => null,
	} as unknown as ModelCatalogStore;
}

describe('composerModelSelectorMode', () => {
	it('exposes agent and source selection when multiple agents are configured', () => {
		const catalog = makeCatalog({
			agents: ['claude', 'codex'],
			models: {
				claude: [{ value: 'opus', label: 'Opus' }],
				codex: [{ value: 'gpt-5.5', label: 'GPT-5.5' }],
			},
		});

		expect(composerModelSelectorMode(catalog, 'claude')).toEqual({
			agent: 'select',
			source: 'select',
			surface: 'composer',
		});
	});

	it('stays compact when a single agent has a single source', () => {
		const catalog = makeCatalog({
			agents: ['claude'],
			models: { claude: [{ value: 'opus', label: 'Opus' }] },
			labels: { claude: 'Claude' },
		});

		expect(composerModelSelectorMode(catalog, 'claude')).toEqual({
			agent: 'fixed',
			source: 'hidden',
			surface: 'composer',
		});
	});

	it('offers source selection for a single agent that has multiple sources', () => {
		const catalog = makeCatalog({
			agents: ['claude'],
			models: {
				claude: [
					{ value: 'opus', label: 'Opus' },
					{
						value: 'acme-anthropic:acme-sonnet',
						label: 'Acme: Sonnet',
						rawModel: 'acme-sonnet',
						apiProviderId: 'acme',
						endpointId: 'acme-anthropic',
						protocol: 'anthropic-messages',
					},
				],
			},
			labels: { claude: 'Claude' },
		});

		expect(composerModelSelectorMode(catalog, 'claude')).toEqual({
			agent: 'fixed',
			source: 'select',
			surface: 'composer',
		});
	});
});
