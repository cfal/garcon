import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelCatalogStore } from '../model-catalog.svelte';
import * as clientApi from '$lib/api/client';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';

vi.mock('$lib/api/client', () => ({
	apiFetch: vi.fn(),
}));

const STORAGE_KEY = LOCAL_STORAGE_KEYS.modelCatalog;
const LEGACY_STORAGE_KEY = LOCAL_STORAGE_KEYS.modelCatalogLegacy;
const PI_MODEL = {
	value: 'github-copilot/gpt-5.4',
	label: 'github-copilot: gpt-5.4',
	supportsImages: true,
};

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(headers),
		text: async () => '',
		json: async () => body,
	} as unknown as Response;
}

function catalogBody(agents: unknown[], apiProviders: unknown[] = []): unknown {
	return {
		catalog: {
			agents,
			apiProviders,
		},
	};
}

function piAgent(models: unknown[], defaultModel = ''): unknown {
	return {
		id: 'pi',
		label: 'Pi',
		kind: 'agent',
		supportsFork: true,
		supportsImages: false,
		acceptsApiProviderEndpoints: false,
		supportedProtocols: [],
		defaultModel,
		models,
	};
}

describe('ModelCatalogStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

	it('uses static fallbacks before remote hydration', () => {
		const store = createModelCatalogStore();
		expect(store.getModels('claude').length).toBeGreaterThan(0);
		expect(store.getModels('codex').length).toBeGreaterThan(0);
		expect(store.getModels('cursor')).toEqual([]);
		expect(store.getModels('factory').length).toBeGreaterThan(0);
		expect(store.getModels('pi')).toEqual([]);
		expect(store.getModels('direct-anthropic-compatible')).toEqual([]);
		expect(store.getModels('direct-openai-compatible')).toEqual([]);
		expect(store.getModels('direct-openai-responses-compatible')).toEqual([]);
		expect(store.getSelectableAgents()).toContain('pi');
		expect(store.getSelectableAgents()).not.toContain('direct-anthropic-compatible');
		expect(store.getSelectableAgents()).not.toContain('direct-openai-compatible');
		expect(store.getSelectableAgents()).not.toContain('direct-openai-responses-compatible');
		expect(store.getModels('zai')).toEqual([]);
		expect(store.getDefaultModel('claude')).toBe('opus');
		expect(store.getDefaultModel('codex')).toBe('gpt-5.5');
		expect(store.getDefaultModel('cursor')).toBe('');
		expect(store.getDefaultModel('pi')).toBe('');
		expect(store.getModels('codex')[0]).toEqual({
			value: 'gpt-5.5',
			label: 'GPT-5.5',
			supportsImages: true,
		});
		const codexModelValues = store.getModels('codex').map((model) => model.value);
		expect(codexModelValues).toContain('gpt-5.3-codex-spark');
		expect(store.supportsImages('codex', 'gpt-5.3-codex-spark')).toBe(false);
		expect(codexModelValues).not.toContain('gpt-5.2');
		expect(codexModelValues).not.toContain('gpt-5.2-codex');
		expect(codexModelValues).not.toContain('gpt-5.1-codex-max');
		expect(codexModelValues).not.toContain('gpt-5.1-codex-mini');
		const factoryModelValues = store.getModels('factory').map((model) => model.value);
		expect(factoryModelValues).not.toContain('gpt-5.2');
		expect(factoryModelValues).not.toContain('gpt-5.2-codex');
		expect(factoryModelValues).not.toContain('gpt-5.1-codex-max');
	});

	it('exposes default capabilities from common contract', () => {
		const store = createModelCatalogStore();
		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsFork('codex')).toBe(true);
		expect(store.supportsFork('opencode')).toBe(false);
		expect(store.supportsFork('cursor')).toBe(true);
		expect(store.supportsFork('pi')).toBe(true);
		expect(store.supportsFork('zai')).toBe(false);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(true);
		expect(store.supportsImages('opencode')).toBe(false);
		expect(store.supportsImages('cursor')).toBe(false);
		expect(store.supportsImages('pi')).toBe(false);
		expect(store.supportsImages('zai')).toBe(false);
		expect(store.supportsImages('factory', 'claude-opus-4-6')).toBe(true);
		expect(store.supportsImages('factory', 'glm-5')).toBe(false);
	});

	it('hydrates cached agent models from localStorage', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {
					opencode: [{ value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }],
				},
				agentMetadata: {
					opencode: {
						id: 'opencode',
						label: 'OpenCode',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'deepseek/deepseek-chat',
					},
				},
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();
		expect(store.getModels('opencode')).toEqual([
			{ value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
		]);
		expect(store.isStale(60_000)).toBe(false);
	});

	it('migrates v2 snapshots without an etag and validates them on startup', async () => {
		localStorage.setItem(
			LEGACY_STORAGE_KEY,
			JSON.stringify({
				agentModels: {
					opencode: [{ value: 'old/model', label: 'Old Model' }],
				},
				agentMetadata: {
					opencode: {
						id: 'opencode',
						label: 'OpenCode',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'old/model',
					},
				},
				apiProviderCatalog: [],
				lastFetchedAt: Date.now(),
			}),
		);
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(
			mockResponse(
				catalogBody([
					{
						id: 'opencode',
						label: 'OpenCode',
						kind: 'agent',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'new/model',
						models: [{ value: 'new/model', label: 'New Model' }],
					},
				]),
				200,
				{ etag: 'W/"model-catalog:new"' },
			),
		);

		const store = createModelCatalogStore();
		expect(store.getModels('opencode')[0]?.value).toBe('old/model');
		expect(store.etag).toBeNull();

		await store.refreshIfStale();

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models');
		expect(store.getModels('opencode')[0]?.value).toBe('new/model');
		expect(store.etag).toBe('W/"model-catalog:new"');
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').etag).toBe(
			'W/"model-catalog:new"',
		);
	});

	it('hydrates cached Pi entries as stored', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {
					pi: [
						{ value: 'default', label: 'Pi Default' },
						{
							value: 'github-copilot/gpt-5.4',
							label: 'github-copilot: gpt-5.4',
							supportsImages: true,
						},
					],
				},
				agentMetadata: {
					pi: {
						id: 'pi',
						label: 'Pi',
						supportsFork: true,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'default',
					},
				},
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();
		expect(store.getModels('pi')).toEqual([
			{ value: 'default', label: 'Pi Default' },
			{ value: 'github-copilot/gpt-5.4', label: 'github-copilot: gpt-5.4', supportsImages: true },
		]);
		expect(store.getDefaultModel('pi')).toBe('default');
	});

	it('hydrates cached agent capabilities from localStorage', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {},
				agentMetadata: {
					claude: {
						id: 'claude',
						label: 'Claude',
						supportsFork: true,
						supportsImages: true,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['anthropic-messages'],
						defaultModel: 'opus',
					},
					codex: {
						id: 'codex',
						label: 'Codex',
						supportsFork: true,
						supportsImages: false,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['openai-compatible'],
						defaultModel: 'gpt-5.5',
					},
				},
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();
		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(false);
	});

	it('normalizes cached direct agent labels from localStorage', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {},
				agentMetadata: {
					'direct-openai-compatible': {
						id: 'direct-openai-compatible',
						label: 'Direct Chat (OpenAI Chat Completions)',
						supportsFork: false,
						supportsImages: true,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['openai-compatible'],
						defaultModel: '',
					},
					'direct-openai-responses-compatible': {
						id: 'direct-openai-responses-compatible',
						label: 'Direct Chat (OpenAI Responses)',
						supportsFork: false,
						supportsImages: true,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['openai-compatible'],
						defaultModel: '',
					},
					'direct-anthropic-compatible': {
						id: 'direct-anthropic-compatible',
						label: 'Direct Chat (Anthropic)',
						supportsFork: false,
						supportsImages: true,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['anthropic-messages'],
						defaultModel: '',
					},
				},
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();
		expect(store.getAgentLabel('direct-openai-compatible')).toBe('Direct (Chat Completions)');
		expect(store.getAgentLabel('direct-openai-responses-compatible')).toBe('Direct (Responses)');
		expect(store.getAgentLabel('direct-anthropic-compatible')).toBe('Direct (Anthropic)');
	});

	it('does not expose API provider ids as agents from cached metadata', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {
					zai: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
					openrouter: [{ value: 'openai/gpt-5', label: 'GPT-5' }],
				},
				agentMetadata: {
					zai: {
						id: 'zai',
						label: 'Z.AI',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'glm-5.1',
					},
					openrouter: {
						id: 'openrouter',
						label: 'OpenRouter',
						supportsFork: false,
						supportsImages: true,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'openai/gpt-5',
					},
				},
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();
		expect(store.getAgents()).not.toContain('zai');
		expect(store.getAgents()).not.toContain('openrouter');
		expect(store.getModels('zai')).toEqual([]);
		expect(store.getModels('openrouter')).toEqual([]);
	});

	it('refreshes when stale and persists clean catalog results', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'opencode',
							label: 'OpenCode',
							kind: 'agent',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'moonshot/kimi-k2',
							models: [{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }],
						},
					],
					apiProviders: [],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.refreshIfStale(0);

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models');
		expect(store.getModels('opencode')).toEqual([{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }]);
		expect(store.getModels('claude').length).toBeGreaterThan(0);
		expect(store.getModels('codex').length).toBeGreaterThan(0);
	});

	it('keeps hydrated models when the server returns 304', async () => {
		const json = vi.fn();
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {
					opencode: [{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }],
				},
				agentMetadata: {
					opencode: {
						id: 'opencode',
						label: 'OpenCode',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'moonshot/kimi-k2',
					},
				},
				apiProviderCatalog: [],
				etag: 'W/"model-catalog:cached"',
				lastFetchedAt: 100,
				lastValidatedAt: 100,
			}),
		);
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce({
			ok: false,
			status: 304,
			headers: new Headers({ etag: 'W/"model-catalog:cached"' }),
			text: async () => '',
			json,
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.refreshIfStale();

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models', {
			headers: { 'If-None-Match': 'W/"model-catalog:cached"' },
		});
		expect(json).not.toHaveBeenCalled();
		expect(store.getModels('opencode')).toEqual([{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }]);
		expect(store.lastValidatedAt).toEqual(expect.any(Number));
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').lastValidatedAt).toEqual(
			expect.any(Number),
		);
	});

	it('does not revalidate repeatedly inside the validation retry window', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue(
			mockResponse(
				catalogBody([
					{
						id: 'opencode',
						label: 'OpenCode',
						kind: 'agent',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'moonshot/kimi-k2',
						models: [{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }],
					},
				]),
				200,
				{ etag: 'W/"model-catalog:fresh"' },
			),
		);

		const store = createModelCatalogStore();
		await store.refreshIfStale();
		await store.refreshIfStale();

		expect(clientApi.apiFetch).toHaveBeenCalledTimes(1);
	});

	it('parses catalog.agents and catalog.apiProviders from API response', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'claude',
							label: 'Claude Code',
							kind: 'agent',
							supportsFork: true,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['anthropic-messages'],
							defaultModel: 'opus',
							models: [{ value: 'opus', label: 'Opus', supportsImages: true }],
						},
						{
							id: 'codex',
							label: 'Codex',
							kind: 'agent',
							supportsFork: true,
							supportsImages: false,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-compatible'],
							defaultModel: 'gpt-5.3-codex',
							models: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsImages: false }],
						},
						{
							id: 'factory',
							label: 'Factory',
							kind: 'agent',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'claude-opus-4-6',
							models: [
								{ value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true },
							],
						},
					],
					apiProviders: [
						{
							id: 'zai',
							label: 'Z.AI',
							templateId: 'zai',
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
							endpoints: [
								{
									id: 'zai_anthropic',
									protocol: 'anthropic-messages',
									baseUrl: 'https://api.z.ai/api/anthropic',
									defaultModel: 'glm-5.1',
									models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
									supportsImages: false,
									hasApiKey: true,
									modelDiscovery: 'none',
								},
							],
						},
					],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsFork('opencode')).toBe(false);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(false);
		expect(store.supportsImages('factory', 'claude-opus-4-6')).toBe(true);
		expect(store.findEndpoint('zai_anthropic')?.apiProvider.label).toBe('Z.AI');
		const claudeModels = store.getModels('claude');
		expect(claudeModels[0]).toMatchObject({ value: 'opus', label: 'Opus', supportsImages: true });
		expect(claudeModels.find((m) => m.value === 'sonnet')).toBeTruthy();
	});

	it('merges missing static models into catalog results', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'codex',
							label: 'Codex',
							kind: 'agent',
							supportsFork: true,
							supportsImages: false,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-compatible'],
							defaultModel: 'gpt-5.3-codex',
							models: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }],
						},
					],
					apiProviders: [],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		const codexModels = store.getModels('codex');
		expect(codexModels[0]).toMatchObject({ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' });
		expect(codexModels.find((m) => m.value === 'gpt-5.5')).toBeTruthy();
		expect(codexModels.length).toBeGreaterThan(1);
	});

	it('uses Cursor catalog results without static model merging', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'cursor',
							label: 'Cursor',
							kind: 'agent',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'auto',
							models: [{ value: 'auto', label: 'Auto', supportsImages: false }],
						},
					],
					apiProviders: [],
				},
			}),
		} as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.getModels('cursor')).toEqual([
			{ value: 'auto', label: 'Auto', supportsImages: false },
		]);
		expect(store.getDefaultModel('cursor')).toBe('auto');
	});

	it('records an error for invalid catalog responses', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({ claude: [{ value: 'opus', label: 'Opus' }] }),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.error).toBe('Model catalog response is invalid');
		expect(store.getModels('claude').find((m) => m.value === 'sonnet')).toBeTruthy();
	});

	it('validates explicit empty Pi results before persisting the catalog', async () => {
		vi.mocked(clientApi.apiFetch)
			.mockResolvedValueOnce(mockResponse(catalogBody([piAgent([])])))
			.mockResolvedValueOnce(mockResponse(catalogBody([piAgent([PI_MODEL], PI_MODEL.value)])));

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(clientApi.apiFetch).toHaveBeenNthCalledWith(1, '/api/v1/models');
		expect(clientApi.apiFetch).toHaveBeenNthCalledWith(2, '/api/v1/models?agent=pi');
		expect(store.error).toBeNull();
		expect(store.getModels('pi')).toEqual([PI_MODEL]);
		expect(store.lastFetchedAt).toEqual(expect.any(Number));
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}').agentModels.pi).toEqual([
			PI_MODEL,
		]);
	});

	it('does not persist empty Pi results when strict Pi discovery is unavailable', async () => {
		vi.mocked(clientApi.apiFetch)
			.mockResolvedValueOnce(mockResponse(catalogBody([piAgent([])])))
			.mockResolvedValueOnce(
				mockResponse(
					{
						error: 'Pi model discovery unavailable',
						reason: 'auth storage: auth.json is locked',
					},
					503,
				),
			);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.error).toBe('auth storage: auth.json is locked');
		expect(store.getModels('pi')).toEqual([]);
		expect(store.lastFetchedAt).toBeNull();
		expect(store.lastValidatedAt).toBeNull();
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it('uses stale Pi models from a strict 503 body without marking them fresh', async () => {
		vi.mocked(clientApi.apiFetch)
			.mockResolvedValueOnce(mockResponse(catalogBody([piAgent([])])))
			.mockResolvedValueOnce(
				mockResponse(
					{
						error: 'Pi model discovery unavailable',
						reason: 'auth storage: auth.json is locked',
						catalog: {
							agents: [piAgent([PI_MODEL], PI_MODEL.value)],
							apiProviders: [],
						},
					},
					503,
				),
			);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		expect(store.error).toBe('auth storage: auth.json is locked');
		expect(store.getModels('pi')).toEqual([PI_MODEL]);
		expect(store.lastFetchedAt).toBeNull();
		expect(store.lastValidatedAt).toBeNull();
		expect(store.etag).toBeNull();
		expect(persisted.agentModels.pi).toEqual([PI_MODEL]);
		expect(persisted.lastFetchedAt).toBeNull();
		expect(persisted.lastValidatedAt).toBeNull();
		expect(persisted.etag).toBeNull();
	});

	it('preserves cached Pi models on strict discovery failures without storing an empty refresh', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: {
					pi: [PI_MODEL],
				},
				agentMetadata: {
					pi: {
						id: 'pi',
						label: 'Pi',
						supportsFork: true,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: PI_MODEL.value,
					},
				},
				apiProviderCatalog: [],
				lastFetchedAt: Date.now(),
			}),
		);
		vi.mocked(clientApi.apiFetch)
			.mockResolvedValueOnce(mockResponse(catalogBody([piAgent([])])))
			.mockResolvedValueOnce(
				mockResponse(
					{
						error: 'Pi model discovery unavailable',
						reason: 'auth storage: auth.json is locked',
					},
					503,
				),
			);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
		expect(store.error).toBe('auth storage: auth.json is locked');
		expect(store.getModels('pi')).toEqual([PI_MODEL]);
		expect(store.lastFetchedAt).toBeNull();
		expect(store.lastValidatedAt).toBeNull();
		expect(store.etag).toBeNull();
		expect(persisted.agentModels.pi).toEqual([PI_MODEL]);
		expect(persisted.lastFetchedAt).toBeNull();
		expect(persisted.lastValidatedAt).toBeNull();
		expect(persisted.etag).toBeNull();
	});

	it('prefers model-level image capability when present', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'factory',
							label: 'Factory',
							kind: 'agent',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'claude-opus-4-6',
							models: [
								{ value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true },
								{ value: 'glm-5', label: 'Droid Core (GLM-5)', supportsImages: false },
							],
						},
					],
					apiProviders: [],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.supportsImages('factory', 'claude-opus-4-6')).toBe(true);
		expect(store.supportsImages('factory', 'glm-5')).toBe(false);
	});

	it('preserves API provider metadata and maps selection values to raw models', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'direct-openai-compatible',
							label: 'Direct (Chat Completions)',
							kind: 'agent',
							supportsFork: false,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-compatible'],
							defaultModel: 'zai_openai:glm-5.1',
							models: [
								{
									value: 'zai_openai:glm-5.1',
									label: 'Z.AI: GLM-5.1',
									rawModel: 'glm-5.1',
									apiProviderId: 'zai',
									endpointId: 'zai_openai',
									protocol: 'openai-compatible',
									supportsImages: false,
								},
							],
						},
					],
					apiProviders: [
						{
							id: 'zai',
							label: 'Z.AI',
							templateId: 'zai',
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
							endpoints: [
								{
									id: 'zai_openai',
									protocol: 'openai-compatible',
									baseUrl: 'https://api.z.ai/api/coding/paas/v4',
									capabilities: { chatCompletions: true, responses: false },
									defaultModel: 'glm-5.1',
									models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
									supportsImages: false,
									hasApiKey: true,
									modelDiscovery: 'none',
								},
							],
						},
					],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.selectionFor('direct-openai-compatible', 'zai_openai:glm-5.1')).toEqual({
			model: 'glm-5.1',
			apiProviderId: 'zai',
			modelEndpointId: 'zai_openai',
			modelProtocol: 'openai-compatible',
		});
		expect(store.selectionValueFor('direct-openai-compatible', 'glm-5.1', 'zai_openai')).toBe(
			'zai_openai:glm-5.1',
		);
		expect(store.supportsImages('direct-openai-compatible', 'glm-5.1', 'zai_openai')).toBe(false);
		expect(store.findEndpoint('zai_openai')?.endpoint.defaultModel).toBe('glm-5.1');
	});

	it('maps Direct Responses endpoint selections to raw models', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'direct-openai-responses-compatible',
							label: 'Direct (Responses)',
							kind: 'agent',
							supportsFork: false,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-compatible'],
							defaultModel: 'acme_openai:acme-code',
							models: [
								{
									value: 'acme_openai:acme-code',
									label: 'Acme: Acme Code',
									rawModel: 'acme-code',
									apiProviderId: 'acme',
									endpointId: 'acme_openai',
									protocol: 'openai-compatible',
									supportsImages: false,
								},
							],
						},
					],
					apiProviders: [
						{
							id: 'acme',
							label: 'Acme',
							templateId: 'custom',
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
							endpoints: [
								{
									id: 'acme_openai',
									protocol: 'openai-compatible',
									baseUrl: 'https://api.acme.test/v1',
									capabilities: { chatCompletions: false, responses: true },
									defaultModel: 'acme-code',
									models: [{ value: 'acme-code', label: 'Acme Code' }],
									supportsImages: false,
									hasApiKey: true,
									modelDiscovery: 'openai-models',
								},
							],
						},
					],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.getSelectableAgents()).toContain('direct-openai-responses-compatible');
		expect(
			store.selectionFor('direct-openai-responses-compatible', 'acme_openai:acme-code'),
		).toEqual({
			model: 'acme-code',
			apiProviderId: 'acme',
			modelEndpointId: 'acme_openai',
			modelProtocol: 'openai-compatible',
		});
		expect(store.findEndpoint('acme_openai')?.endpoint.capabilities).toEqual({
			chatCompletions: false,
			responses: true,
		});
	});

	it('maps Direct Anthropic endpoint selections to raw models', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					agents: [
						{
							id: 'direct-anthropic-compatible',
							label: 'Direct (Anthropic)',
							kind: 'agent',
							supportsFork: false,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['anthropic-messages'],
							defaultModel: 'acme_anthropic:acme-sonnet',
							models: [
								{
									value: 'acme_anthropic:acme-sonnet',
									label: 'Acme: Acme Sonnet',
									rawModel: 'acme-sonnet',
									apiProviderId: 'acme',
									endpointId: 'acme_anthropic',
									protocol: 'anthropic-messages',
									supportsImages: true,
								},
							],
						},
					],
					apiProviders: [
						{
							id: 'acme',
							label: 'Acme',
							templateId: 'custom',
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
							endpoints: [
								{
									id: 'acme_anthropic',
									protocol: 'anthropic-messages',
									baseUrl: 'https://api.acme.test',
									defaultModel: 'acme-sonnet',
									models: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
									supportsImages: true,
									hasApiKey: true,
									modelDiscovery: 'anthropic-models',
								},
							],
						},
					],
				},
			}),
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.getSelectableAgents()).toContain('direct-anthropic-compatible');
		expect(store.selectionFor('direct-anthropic-compatible', 'acme_anthropic:acme-sonnet')).toEqual(
			{
				model: 'acme-sonnet',
				apiProviderId: 'acme',
				modelEndpointId: 'acme_anthropic',
				modelProtocol: 'anthropic-messages',
			},
		);
		expect(
			store.selectionValueFor('direct-anthropic-compatible', 'acme-sonnet', 'acme_anthropic'),
		).toBe('acme_anthropic:acme-sonnet');
		expect(
			store.supportsImages('direct-anthropic-compatible', 'acme-sonnet', 'acme_anthropic'),
		).toBe(true);
		expect(store.findEndpoint('acme_anthropic')?.endpoint.defaultModel).toBe('acme-sonnet');
	});
});
