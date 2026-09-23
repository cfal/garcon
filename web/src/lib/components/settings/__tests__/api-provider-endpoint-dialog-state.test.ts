import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createApiProvider,
	updateApiProvider,
	deleteApiProvider,
	discoverApiProviderModels,
	testApiProvider,
} from '$lib/api/api-providers.js';
import {
	ApiProviderEndpointDialogState,
} from '../api-provider-endpoint-dialog-state.svelte';
import { ModelCatalogStore } from '$lib/agents/model-catalog-store.svelte';
import type { ApiProviderCatalogEntry } from '$shared/api-providers';

vi.mock('$lib/api/api-providers.js', () => ({
	createApiProvider: vi.fn(),
	deleteApiProvider: vi.fn(),
	discoverApiProviderModels: vi.fn(),
	testApiProvider: vi.fn(),
	updateApiProvider: vi.fn(),
}));

function makeModelCatalog(endpoint: ReturnType<ModelCatalogStore['findEndpoint']> = null) {
	return {
		nodeId: 'local',
		findEndpoint: vi.fn(() => endpoint),
		forceRefresh: vi.fn().mockResolvedValue(undefined),
		invalidateAll: vi.fn(),
	};
}

function dialogPorts(catalog: Pick<ModelCatalogStore, 'nodeId' | 'findEndpoint' | 'forceRefresh' | 'invalidateAll'> = makeModelCatalog()) {
	return {
		modelCatalog: catalog,
		providers: {
			findEndpoint: catalog.findEndpoint,
			isAssigned: () => true,
			invalidate: () => catalog.invalidateAll(),
			refresh: async () => {},
		},
		isNodeReady: () => true,
	} satisfies Pick<ConstructorParameters<typeof ApiProviderEndpointDialogState>[0], 'modelCatalog' | 'providers' | 'isNodeReady'>;
}

describe('ApiProviderEndpointDialogState', () => {
	beforeEach(() => {
		vi.mocked(createApiProvider).mockReset();
		vi.mocked(updateApiProvider).mockReset();
		vi.mocked(deleteApiProvider).mockReset();
		vi.mocked(discoverApiProviderModels).mockReset();
		vi.mocked(testApiProvider).mockReset();
	});

	it('omits OpenAI capabilities for Anthropic-compatible endpoints', () => {
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
		});

		dialog.beginCreate();

		expect(dialog.usesOpenAiCapabilityToggles).toBe(false);
		expect(dialog.supportsChatCompletionsApi).toBe(false);
		expect(dialog.supportsResponsesApi).toBe(false);
		expect(dialog.hasRequiredApiCapability).toBe(true);
		expect(dialog.payload().endpoint.capabilities).toBeUndefined();
	});

	it('maps OpenAI capability toggles to endpoint capabilities', () => {
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
		});

		dialog.beginCreate();

		expect(dialog.usesOpenAiCapabilityToggles).toBe(true);
		expect(dialog.supportsChatCompletionsApi).toBe(true);
		expect(dialog.supportsResponsesApi).toBe(false);
		expect(dialog.payload().endpoint.capabilities).toEqual({
			chatCompletions: true,
			responses: false,
		});

		dialog.setSupportsResponsesApi(true);

		expect(dialog.supportsResponsesApi).toBe(true);
		expect(dialog.payload().endpoint.capabilities).toEqual({
			chatCompletions: true,
			responses: true,
		});

		dialog.setSupportsChatCompletionsApi(false);

		expect(dialog.supportsChatCompletionsApi).toBe(false);
		expect(dialog.payload().endpoint.capabilities).toEqual({
			chatCompletions: false,
			responses: true,
		});
	});

	it('loads edit state without exposing the stored API key', async () => {
		const endpoint: NonNullable<ReturnType<ModelCatalogStore['findEndpoint']>> = {
			apiProvider: {
				id: 'zai',
				revision: 1, createdAt: '', updatedAt: '', endpoints: [],
				label: 'Z.AI',
				templateId: 'zai',
			},
			endpoint: {
				id: 'zai_openai',
				protocol: 'openai-compatible',
				baseUrl: 'https://api.z.ai/api/coding/paas/v4',
				capabilities: { chatCompletions: false, responses: true },
				defaultModel: 'glm-5.1',
				models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
				supportsImages: false,
				hasApiKey: true,
				modelDiscovery: 'none',
			},
		};
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog(endpoint)),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => 'zai_openai',
			getTemplateId: () => 'custom',
		});

		await dialog.load();

		expect(dialog.apiProviderId).toBe('zai');
		expect(dialog.label).toBe('Z.AI');
		expect(dialog.apiKey).toBe('');
		expect(dialog.supportsResponsesApi).toBe(true);
		expect(dialog.supportsChatCompletionsApi).toBe(false);
	});

	it('prefills OpenRouter template values for OpenAI-compatible creation', () => {
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'openrouter',
		});

		dialog.beginCreate();

		expect(dialog.templateId).toBe('openrouter');
		expect(dialog.label).toBe('OpenRouter');
		expect(dialog.baseUrl).toBe('https://openrouter.ai/api/v1');
		expect(dialog.modelDiscovery).toBe('openrouter-models');
		expect(dialog.supportsResponsesApi).toBe(true);
		expect(dialog.supportsChatCompletionsApi).toBe(true);
		expect(dialog.apiKeyRequired).toBe(true);
	});

	it('prefills Alibaba Cloud Singapore URLs for both protocols', () => {
		const anthropicDialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'alibaba-cloud',
		});
		const openAiDialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'alibaba-cloud',
		});

		anthropicDialog.beginCreate();
		openAiDialog.beginCreate();

		expect(anthropicDialog.label).toBe('Alibaba Cloud');
		expect(anthropicDialog.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/apps/anthropic');
		expect(anthropicDialog.defaultModel).toBe('qwen-plus');
		expect(anthropicDialog.apiKeyPlaceholder).toBe('Alibaba Cloud API key');
		expect(openAiDialog.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
		expect(openAiDialog.defaultModel).toBe('qwen-plus');
		expect(openAiDialog.modelDiscovery).toBe('openai-models');
		expect(openAiDialog.supportsResponsesApi).toBe(true);
		expect(openAiDialog.supportsChatCompletionsApi).toBe(true);
	});

	it('prefills Fireworks, Gemini, and Together provider templates', () => {
		const fireworksAnthropicDialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'fireworks',
		});
		const fireworksOpenAiDialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'fireworks',
		});
		const geminiDialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'gemini',
		});
		const togetherDialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'together',
		});

		fireworksAnthropicDialog.beginCreate();
		fireworksOpenAiDialog.beginCreate();
		geminiDialog.beginCreate();
		togetherDialog.beginCreate();

		expect(fireworksAnthropicDialog.baseUrl).toBe('https://api.fireworks.ai/inference');
		expect(fireworksOpenAiDialog.baseUrl).toBe('https://api.fireworks.ai/inference/v1');
		expect(fireworksOpenAiDialog.defaultModel).toBe('accounts/fireworks/models/kimi-k2p5');
		expect(fireworksOpenAiDialog.apiKeyPlaceholder).toBe('Fireworks.ai API key');
		expect(fireworksOpenAiDialog.supportsResponsesApi).toBe(true);
		expect(fireworksOpenAiDialog.supportsChatCompletionsApi).toBe(true);
		expect(geminiDialog.label).toBe('Gemini');
		expect(geminiDialog.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
		expect(geminiDialog.defaultModel).toBe('gemini-3-flash-preview');
		expect(geminiDialog.supportsImages).toBe(true);
		expect(geminiDialog.apiKeyPlaceholder).toBe('Gemini API key');
		expect(geminiDialog.supportsResponsesApi).toBe(false);
		expect(geminiDialog.supportsChatCompletionsApi).toBe(true);
		expect(togetherDialog.label).toBe('Together.ai');
		expect(togetherDialog.baseUrl).toBe('https://api.together.ai/v1');
		expect(togetherDialog.defaultModel).toBe('openai/gpt-oss-20b');
		expect(togetherDialog.apiKeyPlaceholder).toBe('Together.ai API key');
		expect(togetherDialog.supportsResponsesApi).toBe(false);
		expect(togetherDialog.supportsChatCompletionsApi).toBe(true);
	});

	it('prefills Ollama template with blank key support', () => {
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'ollama',
		});

		dialog.beginCreate();

		expect(dialog.templateId).toBe('ollama');
		expect(dialog.label).toBe('Ollama');
		expect(dialog.apiKey).toBe('');
		expect(dialog.apiKeyRequired).toBe(false);
		expect(dialog.modelDiscovery).toBe('ollama-tags');
		expect(dialog.supportsResponsesApi).toBe(true);
		expect(dialog.supportsChatCompletionsApi).toBe(true);
	});

	it('requires a parsed model, valid default model, and at least one API capability before saving', () => {
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
		});

		dialog.beginCreate();
		dialog.label = 'Acme';
		dialog.baseUrl = 'https://api.acme.test/v1';

		expect(dialog.supportsResponsesApi).toBe(false);
		expect(dialog.supportsChatCompletionsApi).toBe(true);
		expect(dialog.canSave).toBe(false);

		dialog.modelsText = 'acme-code|Acme Code';
		dialog.syncDefaultModelWithModels();

		expect(dialog.defaultModel).toBe('acme-code');
		expect(dialog.canSave).toBe(true);

		dialog.setSupportsChatCompletionsApi(false);
		expect(dialog.canSave).toBe(false);

		dialog.setSupportsResponsesApi(true);
		expect(dialog.canSave).toBe(true);

		dialog.defaultModel = 'missing-model';
		expect(dialog.canSave).toBe(false);
	});

	it('fetches OpenAI-compatible models and uses them as default model choices', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [
				{ value: 'acme-fast', label: 'Acme Fast' },
				{ value: 'acme-code', label: 'Acme Code' },
			],
		});
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
		});

		dialog.beginCreate();
		dialog.baseUrl = 'https://api.acme.test/v1';

		await dialog.fetchModels();

		expect(discoverApiProviderModels).toHaveBeenCalledWith({
			protocol: 'openai-compatible',
			baseUrl: 'https://api.acme.test/v1',
			apiKey: undefined,
			apiProviderId: null,
			endpointId: null,
			revision: undefined,
			modelDiscovery: 'openai-models',
		}, 'local');
		expect(dialog.modelsText).toBe('acme-code|Acme Code\nacme-fast|Acme Fast');
		expect(dialog.defaultModel).toBe('acme-code');
		expect(dialog.modelOptions.map((model) => model.value)).toEqual(['acme-code', 'acme-fast']);
	});

	it('uses Anthropic model discovery for custom Anthropic-compatible providers', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [{ value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' }],
		});
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
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
			revision: undefined,
			modelDiscovery: 'anthropic-models',
		}, 'local');
		expect(dialog.modelDiscovery).toBe('anthropic-models');
		expect(dialog.defaultModel).toBe('claude-sonnet-4-20250514');
	});

	it('keeps Anthropic payload free of OpenAI capabilities when fetching Anthropic models', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
		});
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog()),
			getProtocol: () => 'anthropic-messages',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
		});

		dialog.beginCreate();
		dialog.baseUrl = 'https://api.acme.test';

		await dialog.fetchModels();

		expect(discoverApiProviderModels).toHaveBeenCalledWith({
			protocol: 'anthropic-messages',
			baseUrl: 'https://api.acme.test',
			apiKey: undefined,
			apiProviderId: null,
			endpointId: null,
			revision: undefined,
			modelDiscovery: 'anthropic-models',
		}, 'local');
		expect(dialog.payload().endpoint.capabilities).toBeUndefined();
		expect(dialog.defaultModel).toBe('acme-sonnet');
	});

	it('allows model fetching on edit when the stored key is redacted from the dialog', async () => {
		vi.mocked(discoverApiProviderModels).mockResolvedValueOnce({
			success: true,
			models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
		});
		const endpoint: NonNullable<ReturnType<ModelCatalogStore['findEndpoint']>> = {
			apiProvider: {
				id: 'zai',
				revision: 1, createdAt: '', updatedAt: '', endpoints: [],
				label: 'Z.AI',
				templateId: 'zai',
			},
			endpoint: {
				id: 'zai_openai',
				protocol: 'openai-compatible',
				baseUrl: 'https://api.z.ai/api/coding/paas/v4',
				capabilities: { chatCompletions: false, responses: true },
				defaultModel: 'glm-5.1',
				models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
				supportsImages: false,
				hasApiKey: true,
				modelDiscovery: 'none',
			},
		};
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(makeModelCatalog(endpoint)),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => 'zai_openai',
			getTemplateId: () => 'custom',
		});

		await dialog.load();

		expect(dialog.apiKey).toBe('');
		expect(dialog.canFetchModels).toBe(true);

		await dialog.fetchModels();

		expect(discoverApiProviderModels).toHaveBeenCalledWith({
			protocol: 'openai-compatible',
			baseUrl: 'https://api.z.ai/api/coding/paas/v4',
			apiKey: undefined,
			apiProviderId: 'zai',
			endpointId: 'zai_openai',
			revision: 1,
			modelDiscovery: 'openai-models',
		}, 'local');
	});

	it.each(['fetchModels', 'test'] as const)('runs %s on the selected node and discards a response after switching nodes', async (operation) => {
		const nodeId = '22222222-2222-4222-8222-222222222222';
		const remote = { ...makeModelCatalog(), nodeId, findEndpoint: () => null };
		let catalog = remote;
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(remote),
			get modelCatalog() { return catalog; },
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
		});
		await dialog.load();
		dialog.label = 'Synthetic endpoint';
		dialog.baseUrl = 'http://localhost:11434/v1';
		dialog.modelsText = 'synthetic-model';
		dialog.defaultModel = 'synthetic-model';
		const api = operation === 'fetchModels' ? discoverApiProviderModels : testApiProvider;
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof api>>>();
		vi.mocked(api).mockReturnValueOnce(pending.promise);
		const request = dialog[operation]();
		expect(api).toHaveBeenLastCalledWith(expect.any(Object), nodeId);

		catalog = { ...remote, nodeId: 'local' };
		await dialog.load();
		dialog.modelsText = 'current-model';
		pending.resolve({ success: true, models: [{ value: 'stale-model', label: 'Stale Model' }] });
		await request;
		expect(dialog.modelsText).toBe('current-model');
		expect(dialog.testMessage).toBeNull();
		expect(dialog.error).toBeNull();
		expect(dialog.isTesting).toBe(false);
		expect(dialog.isFetchingModels).toBe(false);
	});

	it.each(['fetchModels', 'test'] as const)('preserves the editor draft and fences %s across a host round trip', async (operation) => {
		const remote = { ...makeModelCatalog(), nodeId: '22222222-2222-4222-8222-222222222222' };
		let catalog = remote;
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(remote), get modelCatalog() { return catalog; },
			getProtocol: () => 'openai-compatible', getEndpointId: () => null,
		});
		await dialog.load();
		dialog.label = 'Synthetic draft';
		dialog.apiKey = 'synthetic-key';
		dialog.baseUrl = 'http://localhost:11434/v1';
		dialog.modelsText = 'synthetic-model';
		dialog.defaultModel = 'synthetic-model';
		const draft = dialog.payload();
		const api = operation === 'fetchModels' ? discoverApiProviderModels : testApiProvider;
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof api>>>();
		vi.mocked(api).mockReturnValueOnce(pending.promise);
		const request = dialog[operation]();
		dialog.clearProbeResults();
		catalog = { ...remote, nodeId: 'local' };
		expect(dialog.payload()).toEqual(draft);
		expect(dialog.isTesting).toBe(false);
		expect(dialog.isFetchingModels).toBe(false);
		dialog.clearProbeResults();
		catalog = remote;
		pending.resolve({ success: true, models: [{ value: 'stale', label: 'Stale' }] });
		await request;
		expect(dialog.payload()).toEqual(draft);
		expect(dialog.testMessage).toBeNull();
	});

	it('refreshes the captured remote catalog after saving without closing a replacement dialog', async () => {
		const remote = { ...makeModelCatalog(), nodeId: '22222222-2222-4222-8222-222222222222', findEndpoint: () => null };
		const local = { ...remote, nodeId: 'local', forceRefresh: vi.fn(async () => {}) };
		let catalog = remote;
		const onSaved = vi.fn();
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(remote),
			get modelCatalog() { return catalog; },
			getProtocol: () => 'openai-compatible', getEndpointId: () => null, onSaved,
		});
		await dialog.load();
		dialog.label = 'Synthetic endpoint';
		dialog.baseUrl = 'http://localhost:11434/v1';
		dialog.modelsText = 'synthetic-model';
		dialog.defaultModel = 'synthetic-model';
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof createApiProvider>>>();
		vi.mocked(createApiProvider).mockReturnValueOnce(pending.promise);
		const request = dialog.save();
		catalog = local;
		await dialog.load();
		pending.resolve({ id: 'synthetic', revision: 1, assignment: { nodeId: remote.nodeId, status: 'assigned' }, label: 'Synthetic', createdAt: '', updatedAt: '', endpoints: [] });
		await request;
		expect(remote.forceRefresh).toHaveBeenCalledOnce();
		expect(local.forceRefresh).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
	});

	it.each(['create', 'update'] as const)('invalidates every node catalog after a remote %s', async (operation) => {
		const provider: ApiProviderCatalogEntry = {
			id: 'synthetic', revision: 1, label: 'Synthetic endpoint', templateId: 'custom', createdAt: '', updatedAt: '',
			endpoints: [{
				id: 'synthetic_openai', protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1',
				defaultModel: 'synthetic-model', models: [{ value: 'synthetic-model', label: 'Synthetic Model' }],
				supportsImages: false, hasApiKey: false, modelDiscovery: 'openai-models',
			}],
		};
		const root = new ModelCatalogStore();
		const remote = root.forNode('22222222-2222-4222-8222-222222222222');
		const other = root.forNode('33333333-3333-4333-8333-333333333333');
		for (const catalog of [root, remote, other]) {
			catalog.apiProviderCatalog = [provider];
			catalog.lastValidatedAt = Date.now();
			expect(catalog.isValidated).toBe(true);
		}
		const refresh = vi.spyOn(remote, 'forceRefresh').mockImplementation(async () => {
			for (const catalog of [root, remote, other]) expect(catalog.isValidated).toBe(false);
			remote.lastValidatedAt = Date.now();
		});
		vi.mocked(createApiProvider).mockResolvedValueOnce({ ...provider, assignment: { nodeId: remote.nodeId, status: 'assigned' } });
		vi.mocked(updateApiProvider).mockResolvedValueOnce(provider);
		vi.mocked(deleteApiProvider).mockResolvedValueOnce({ success: true });
		{
			const dialog = new ApiProviderEndpointDialogState({
				providers: { findEndpoint: (id) => remote.findEndpoint(id), isAssigned: () => true,
					invalidate: () => root.invalidateAll(), refresh: async () => {} },
				isNodeReady: () => true,
				modelCatalog: remote, getProtocol: () => 'openai-compatible',
				getEndpointId: () => operation === 'update' ? 'synthetic_openai' : null,
			});
			await dialog.load();
			dialog.label = 'Synthetic endpoint';
			dialog.baseUrl = 'http://localhost:11434/v1';
			dialog.modelsText = 'synthetic-model';
			dialog.defaultModel = 'synthetic-model';
			await dialog.save();
			expect(dialog.error).toBeNull();
		}
		expect(refresh).toHaveBeenCalledOnce();
		expect(root.isValidated).toBe(false);
		expect(other.isValidated).toBe(false);
		expect(remote.isValidated).toBe(true);
	});

	it('calls forceRefresh after saving a new provider to refresh agentModels', async () => {
		vi.mocked(createApiProvider).mockResolvedValueOnce({ id: 'synthetic', revision: 1,
			assignment: { nodeId: 'local', status: 'assigned' }, label: 'Synthetic', createdAt: '', updatedAt: '', endpoints: [] });
		const catalog = makeModelCatalog();
		const dialog = new ApiProviderEndpointDialogState({
			...dialogPorts(catalog),
			getProtocol: () => 'openai-compatible',
			getEndpointId: () => null,
			getTemplateId: () => 'custom',
			onSaved: vi.fn(),
		});

		dialog.beginCreate();
		dialog.label = 'Test Provider';
		dialog.baseUrl = 'https://api.example.com';
		dialog.apiKey = 'sk-test';
		dialog.modelsText = 'gpt-4|GPT-4';
		dialog.defaultModel = 'gpt-4';

		await dialog.save();

		expect(catalog.forceRefresh).toHaveBeenCalledOnce();
	});

	it.each(['not-assigned', 'unknown'] as const)('retains the saved identity after a %s create outcome without duplicating it', async (status) => {
		const catalog = makeModelCatalog();
		const onSaved = vi.fn();
		const dialog = new ApiProviderEndpointDialogState({ ...dialogPorts(catalog),
			getProtocol: () => 'openai-compatible', getEndpointId: () => null, onSaved });
		await dialog.load();
		dialog.label = 'Synthetic'; dialog.baseUrl = 'http://localhost:1234/v1';
		dialog.modelsText = 'synthetic-model'; dialog.defaultModel = 'synthetic-model';
		vi.mocked(createApiProvider).mockResolvedValueOnce({ id: 'synthetic', revision: 1,
			assignment: { nodeId: 'local', status, error: 'Assignment incomplete' }, label: 'Synthetic', createdAt: '', updatedAt: '', endpoints: [] });
		await dialog.save();
		expect(dialog.apiProviderId).toBe('synthetic');
		expect(dialog.error).toBe('Assignment incomplete');
		expect(onSaved).not.toHaveBeenCalled();
		expect(catalog.forceRefresh).not.toHaveBeenCalled();
		vi.mocked(updateApiProvider).mockResolvedValueOnce({ id: 'synthetic', revision: 2, label: 'Synthetic', createdAt: '', updatedAt: '', endpoints: [] });
		await dialog.save();
		expect(createApiProvider).toHaveBeenCalledTimes(1);
		expect(updateApiProvider).toHaveBeenCalledWith('synthetic', expect.objectContaining({ revision: 1 }));
	});

	it('allows saving an offline configuration without testing or fetching models', async () => {
		const catalog = makeModelCatalog();
		const dialog = new ApiProviderEndpointDialogState({ ...dialogPorts(catalog), isNodeReady: () => false,
			getProtocol: () => 'openai-compatible', getEndpointId: () => null });
		await dialog.load();
		dialog.label = 'Synthetic'; dialog.baseUrl = 'http://localhost:1234/v1';
		dialog.modelsText = 'synthetic-model'; dialog.defaultModel = 'synthetic-model';
		expect(dialog.canSave).toBe(true); expect(dialog.canFetchModels).toBe(false); expect(dialog.canTest).toBe(false);
		await dialog.fetchModels(); await dialog.test();
		expect(testApiProvider).not.toHaveBeenCalled(); expect(discoverApiProviderModels).not.toHaveBeenCalled();
		vi.mocked(createApiProvider).mockResolvedValueOnce({ id: 'synthetic', revision: 1,
			assignment: { nodeId: 'local', status: 'assigned' }, label: 'Synthetic', createdAt: '', updatedAt: '', endpoints: [] });
		await dialog.save();
		expect(dialog.error).toBeNull(); expect(catalog.forceRefresh).not.toHaveBeenCalled();
	});

	it('does not replace newer model edits with an in-flight discovery result', async () => {
		const dialog = new ApiProviderEndpointDialogState({ ...dialogPorts(), getProtocol: () => 'openai-compatible', getEndpointId: () => null });
		await dialog.load();
		dialog.baseUrl = 'http://localhost:1234/v1';
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof discoverApiProviderModels>>>();
		vi.mocked(discoverApiProviderModels).mockReturnValueOnce(pending.promise);
		const request = dialog.fetchModels();
		dialog.modelsText = 'newer-edit';
		pending.resolve({ success: true, models: [{ value: 'stale', label: 'Stale' }] });
		await request;
		expect(dialog.modelsText).toBe('newer-edit'); expect(dialog.testMessage).toBeNull();
	});

});
