import { describe, expect, it } from 'vitest';
import type { ModelCatalogStore, ModelOption } from '$lib/agents/model-catalog-store.svelte';
import type { RecentAgentSetting } from '$shared/settings';
import { buildModelSelectorRecents } from '../model-selector-recents';

const codexModel: ModelOption = { value: 'gpt-5', label: 'gpt-5' };
const ampModel: ModelOption = { value: 'amp-smart', label: 'Amp Smart' };
const claudeEndpointModel: ModelOption = {
	value: 'acme-anthropic:sonnet',
	label: 'Acme: Sonnet',
	rawModel: 'sonnet',
	apiProviderId: 'acme',
	endpointId: 'acme-anthropic',
	protocol: 'anthropic-messages',
};

function makeCatalog(): ModelCatalogStore {
	const modelsByAgent: Record<string, ModelOption[]> = {
		codex: [codexModel],
		claude: [claudeEndpointModel],
		amp: [ampModel],
	};
	const endpoint = {
		id: 'acme-anthropic',
		protocol: 'anthropic-messages' as const,
		baseUrl: 'https://anthropic.example',
		defaultModel: 'sonnet',
		models: [],
		supportsImages: true,
		hasApiKey: true,
	};

	return {
		getSelectableAgents: () => ['codex', 'claude', 'amp'],
		getAgentLabel: (agentId: string) => {
			if (agentId === 'codex') return 'Codex';
			if (agentId === 'amp') return 'Amp';
			return 'Claude';
		},
		getModels: (agentId: string) => modelsByAgent[agentId] ?? [],
		getModelForSelection: (agentId: string, model: string, endpointId?: string | null) =>
			(modelsByAgent[agentId] ?? []).find(
				(entry) =>
					(endpointId ? entry.endpointId === endpointId : true) &&
					(entry.value === model || entry.rawModel === model),
			) ?? null,
		selectionValueFor: (agentId: string, model: string, endpointId?: string | null) => {
			const selected = (modelsByAgent[agentId] ?? []).find(
				(entry) =>
					(endpointId ? entry.endpointId === endpointId : true) &&
					(entry.value === model || entry.rawModel === model),
			);
			return selected?.value ?? model;
		},
		findEndpoint: (endpointId: string) => {
			if (endpointId !== endpoint.id) return null;
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
	} as unknown as ModelCatalogStore;
}

describe('model selector recents', () => {
	it('projects native recent labels as agent, provider, then model', () => {
		const rows = buildModelSelectorRecents(makeCatalog(), [
			{
				agentId: 'codex',
				model: 'gpt-5',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		]);

		expect(rows[0]).toMatchObject({
			agentId: 'codex',
			modelValue: 'gpt-5',
			model: 'gpt-5',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			displayLabel: 'Codex · OpenAI OAuth · gpt-5',
		});
	});

	it('projects endpoint-backed recents without duplicating provider prefixes', () => {
		const rows = buildModelSelectorRecents(makeCatalog(), [
			{
				agentId: 'claude',
				model: 'sonnet',
				apiProviderId: 'acme',
				modelEndpointId: 'acme-anthropic',
				modelProtocol: 'anthropic-messages',
			},
		]);

		expect(rows[0]).toMatchObject({
			agentId: 'claude',
			modelValue: 'acme-anthropic:sonnet',
			model: 'sonnet',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-anthropic',
			modelProtocol: 'anthropic-messages',
			displayLabel: 'Claude · Acme · Sonnet',
		});
	});

	it('omits redundant agent-managed provider labels from recents', () => {
		const rows = buildModelSelectorRecents(makeCatalog(), [
			{
				agentId: 'amp',
				model: 'amp-smart',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
		]);

		expect(rows[0]).toMatchObject({
			agentId: 'amp',
			modelValue: 'amp-smart',
			model: 'amp-smart',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
			sourceLabel: '',
			displayLabel: 'Amp · Amp Smart',
		});
	});

	it('omits stale recents and caps the list at twenty rows', () => {
		const recents: RecentAgentSetting[] = [
			{
				agentId: 'removed-agent' as any,
				model: 'gpt-5',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
			{
				agentId: 'codex',
				model: 'missing-model',
				apiProviderId: null,
				modelEndpointId: null,
				modelProtocol: null,
			},
			...Array.from(
				{ length: 22 },
				(): RecentAgentSetting => ({
					agentId: 'codex',
					model: 'gpt-5',
					apiProviderId: null,
					modelEndpointId: null,
					modelProtocol: null,
				}),
			),
		];

		const rows = buildModelSelectorRecents(makeCatalog(), recents);

		expect(rows).toHaveLength(20);
		expect(rows.every((row) => row.displayLabel === 'Codex · OpenAI OAuth · gpt-5')).toBe(true);
	});
});
