import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverApiProviderModels } from '$lib/api/providers.js';
import { ApiProviderEndpointDialogState } from '../api-provider-endpoint-dialog-state.svelte';

vi.mock('$lib/api/providers.js', () => ({
	createApiProvider: vi.fn(),
	deleteApiProvider: vi.fn(),
	discoverApiProviderModels: vi.fn(),
	testApiProvider: vi.fn(),
	updateApiProvider: vi.fn()
}));

function makeModelCatalog(endpoint: unknown = null) {
	return {
		findEndpoint: vi.fn(() => endpoint),
		forceRefresh: vi.fn().mockResolvedValue(undefined)
	};
}

describe('ApiProviderEndpointDialogState', () => {
	beforeEach(() => {
		vi.mocked(discoverApiProviderModels).mockReset();
	});

	it('shows only Claude Code for Anthropic-compatible endpoints', () => {
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'custom'
		});

		dialog.beginCreate();

		expect(dialog.targetOptions.map((target) => target.harnessId)).toEqual(['claude']);
		expect(dialog.targetOptions.map((target) => target.label)).toEqual(['Use with Claude Code']);
		expect(dialog.exposeTo).toEqual(['claude']);
	});

	it('shows Codex and Direct Chat for OpenAI-compatible endpoints', () => {
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => null,
			getTemplateId: () => 'custom'
		});

		dialog.beginCreate();
		dialog.setTarget('codex', false);

		expect(dialog.targetOptions.map((target) => target.harnessId)).toEqual([
			'codex',
			'direct-openai-compatible'
		]);
		expect(dialog.targetOptions.map((target) => target.label)).toEqual([
			'Use with Codex',
			'Use with Direct Chat'
		]);
		expect(dialog.exposeTo).toEqual(['direct-openai-compatible']);
	});

	it('loads edit state without exposing the stored API key', async () => {
		const endpoint = {
			apiProvider: {
				id: 'zai',
				label: 'Z.AI',
				templateId: 'zai'
			},
			endpoint: {
				id: 'zai_openai',
				protocol: 'openai-chat-completions',
				baseUrl: 'https://api.z.ai/api/coding/paas/v4',
				exposeTo: ['codex'],
				defaultModel: 'glm-5.1',
				models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
				supportsImages: false,
				hasApiKey: true,
				modelDiscovery: 'none'
			}
		};
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog(endpoint) as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => 'zai_openai',
			getTemplateId: () => 'custom'
		});

		await dialog.load();

		expect(dialog.apiProviderId).toBe('zai');
		expect(dialog.label).toBe('Z.AI');
		expect(dialog.apiKey).toBe('');
		expect(dialog.isTargetEnabled('codex')).toBe(true);
		expect(dialog.isTargetEnabled('direct-openai-compatible')).toBe(false);
	});

	it('prefills OpenRouter template values for OpenAI-compatible creation', () => {
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => null,
			getTemplateId: () => 'openrouter'
		});

		dialog.beginCreate();

		expect(dialog.templateId).toBe('openrouter');
		expect(dialog.label).toBe('OpenRouter');
		expect(dialog.baseUrl).toBe('https://openrouter.ai/api/v1');
		expect(dialog.modelDiscovery).toBe('openrouter-models');
		expect(dialog.isTargetEnabled('codex')).toBe(true);
		expect(dialog.isTargetEnabled('direct-openai-compatible')).toBe(true);
		expect(dialog.apiKeyRequired).toBe(true);
	});

	it('prefills Ollama template with blank key support', () => {
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => null,
			getTemplateId: () => 'ollama'
		});

		dialog.beginCreate();

		expect(dialog.templateId).toBe('ollama');
		expect(dialog.label).toBe('Ollama');
		expect(dialog.apiKey).toBe('');
		expect(dialog.apiKeyRequired).toBe(false);
		expect(dialog.modelDiscovery).toBe('ollama-tags');
	});

	it('requires a parsed model and valid default model before saving', () => {
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => null,
			getTemplateId: () => 'custom'
		});

		dialog.beginCreate();
		dialog.label = 'Acme';
		dialog.baseUrl = 'https://api.acme.test/v1';

		expect(dialog.canSave).toBe(false);

		dialog.modelsText = 'acme-code|Acme Code';
		dialog.syncDefaultModelWithModels();

		expect(dialog.defaultModel).toBe('acme-code');
		expect(dialog.canSave).toBe(true);

		dialog.defaultModel = 'missing-model';
		expect(dialog.canSave).toBe(false);
	});

	it('fetches OpenAI-compatible models and uses them as default model choices', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [
				{ value: 'acme-code', label: 'Acme Code' },
				{ value: 'acme-fast', label: 'Acme Fast' }
			]
		});
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => null,
			getTemplateId: () => 'custom'
		});

		dialog.beginCreate();
		dialog.baseUrl = 'https://api.acme.test/v1';

		await dialog.fetchModels();

		expect(discoverApiProviderModels).toHaveBeenCalledWith({
			protocol: 'openai-chat-completions',
			baseUrl: 'https://api.acme.test/v1',
			apiKey: undefined,
			apiProviderId: null,
			endpointId: null,
			modelDiscovery: 'openai-models'
		});
		expect(dialog.modelsText).toBe('acme-code|Acme Code\nacme-fast|Acme Fast');
		expect(dialog.defaultModel).toBe('acme-code');
		expect(dialog.modelOptions.map((model) => model.value)).toEqual(['acme-code', 'acme-fast']);
	});

	it('uses Anthropic model discovery for custom Anthropic-compatible providers', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [{ value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' }]
		});
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog() as never,
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'custom'
		});

		dialog.beginCreate();
		dialog.baseUrl = 'https://api.anthropic.com';

		await dialog.fetchModels();

		expect(discoverApiProviderModels).toHaveBeenCalledWith({
			protocol: 'anthropic-messages',
			baseUrl: 'https://api.anthropic.com',
			apiKey: undefined,
			apiProviderId: null,
			endpointId: null,
			modelDiscovery: 'anthropic-models'
		});
		expect(dialog.modelDiscovery).toBe('anthropic-models');
		expect(dialog.defaultModel).toBe('claude-sonnet-4-20250514');
	});

	it('allows model fetching on edit when the stored key is redacted from the dialog', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [{ value: 'glm-5.1', label: 'GLM-5.1' }]
		});
		const endpoint = {
			apiProvider: {
				id: 'zai',
				label: 'Z.AI',
				templateId: 'zai'
			},
			endpoint: {
				id: 'zai_openai',
				protocol: 'openai-chat-completions',
				baseUrl: 'https://api.z.ai/api/coding/paas/v4',
				exposeTo: ['codex'],
				defaultModel: 'glm-5.1',
				models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
				supportsImages: false,
				hasApiKey: true,
				modelDiscovery: 'none'
			}
		};
		const dialog = new ApiProviderEndpointDialogState({
			modelCatalog: makeModelCatalog(endpoint) as never,
			getProtocol: () => 'openai-chat-completions',
			getEndpointId: () => 'zai_openai',
			getTemplateId: () => 'custom'
		});

		await dialog.load();

		expect(dialog.apiKey).toBe('');
		expect(dialog.canFetchModels).toBe(true);

		await dialog.fetchModels();

		expect(discoverApiProviderModels).toHaveBeenCalledWith({
			protocol: 'openai-chat-completions',
			baseUrl: 'https://api.z.ai/api/coding/paas/v4',
			apiKey: undefined,
			apiProviderId: 'zai',
			endpointId: 'zai_openai',
			modelDiscovery: 'openai-models'
		});
	});
});
