import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelCatalogStore } from '../model-catalog.svelte';
import * as clientApi from '$lib/api/client';

vi.mock('$lib/api/client', () => ({
	apiFetch: vi.fn()
}));

describe('ModelCatalogStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.clearAllMocks();
	});

		it('uses static fallbacks before remote hydration', () => {
			const store = createModelCatalogStore();
			expect(store.getModels('claude').length).toBeGreaterThan(0);
			expect(store.getModels('codex').length).toBeGreaterThan(0);
			expect(store.getModels('factory').length).toBeGreaterThan(0);
			expect(store.getModels('direct-anthropic-compatible')).toEqual([]);
			expect(store.getModels('direct-openai-compatible')).toEqual([]);
			expect(store.getSelectableHarnesses()).not.toContain('direct-anthropic-compatible');
			expect(store.getSelectableHarnesses()).not.toContain('direct-openai-compatible');
			expect(store.getModels('zai')).toEqual([]);
			expect(store.getDefaultModel('claude')).toBe('opus');
			expect(store.getDefaultModel('codex')).toBe('gpt-5.5');
		expect(store.getModels('codex')[0]).toEqual({ value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true });
		const codexModelValues = store.getModels('codex').map((model) => model.value);
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
		expect(store.supportsFork('zai')).toBe(false);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(true);
		expect(store.supportsImages('opencode')).toBe(false);
		expect(store.supportsImages('zai')).toBe(false);
		expect(store.supportsImages('factory', 'claude-opus-4-6')).toBe(true);
		expect(store.supportsImages('factory', 'glm-5')).toBe(false);
	});

	it('hydrates cached harness models from localStorage', () => {
		localStorage.setItem(
			'pref_model_catalog',
			JSON.stringify({
				harnessModels: {
					opencode: [{ value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }]
				},
				harnessMetadata: {
					opencode: {
						id: 'opencode',
						label: 'OpenCode',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'deepseek/deepseek-chat'
					}
				},
				lastFetchedAt: Date.now()
			})
		);

		const store = createModelCatalogStore();
		expect(store.getModels('opencode')).toEqual([
			{ value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }
		]);
		expect(store.isStale(60_000)).toBe(false);
	});

	it('hydrates cached harness capabilities from localStorage', () => {
		localStorage.setItem(
			'pref_model_catalog',
			JSON.stringify({
				harnessModels: {},
				harnessMetadata: {
					claude: {
						id: 'claude',
						label: 'Claude',
						supportsFork: true,
						supportsImages: true,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['anthropic-messages'],
						defaultModel: 'opus'
					},
					codex: {
						id: 'codex',
						label: 'Codex',
						supportsFork: true,
						supportsImages: false,
						acceptsApiProviderEndpoints: true,
						supportedProtocols: ['openai-chat-completions'],
						defaultModel: 'gpt-5.5'
					}
				},
				lastFetchedAt: Date.now()
			})
		);

		const store = createModelCatalogStore();
		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(false);
	});

	it('does not expose API provider ids as harnesses from cached metadata', () => {
		localStorage.setItem(
			'pref_model_catalog',
			JSON.stringify({
				harnessModels: {
					zai: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
					openrouter: [{ value: 'openai/gpt-5', label: 'GPT-5' }]
				},
				harnessMetadata: {
					zai: {
						id: 'zai',
						label: 'Z.AI',
						supportsFork: false,
						supportsImages: false,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'glm-5.1'
					},
					openrouter: {
						id: 'openrouter',
						label: 'OpenRouter',
						supportsFork: false,
						supportsImages: true,
						acceptsApiProviderEndpoints: false,
						supportedProtocols: [],
						defaultModel: 'openai/gpt-5'
					}
				},
				lastFetchedAt: Date.now()
			})
		);

		const store = createModelCatalogStore();
		expect(store.getHarnesses()).not.toContain('zai');
		expect(store.getHarnesses()).not.toContain('openrouter');
		expect(store.getModels('zai')).toEqual([]);
		expect(store.getModels('openrouter')).toEqual([]);
	});

	it('refreshes when stale and persists clean catalog results', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					harnesses: [
						{
							id: 'opencode',
							label: 'OpenCode',
							kind: 'harness',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'moonshot/kimi-k2',
							models: [{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }]
						}
					],
					apiProviders: []
				}
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.refreshIfStale(0);

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models');
		expect(store.getModels('opencode')).toEqual([{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }]);
		expect(store.getModels('claude').length).toBeGreaterThan(0);
		expect(store.getModels('codex').length).toBeGreaterThan(0);
	});

	it('parses catalog.harnesses and catalog.apiProviders from API response', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					harnesses: [
						{
							id: 'claude',
							label: 'Claude Code',
							kind: 'harness',
							supportsFork: true,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['anthropic-messages'],
							defaultModel: 'opus',
							models: [{ value: 'opus', label: 'Opus', supportsImages: true }]
						},
						{
							id: 'codex',
							label: 'Codex',
							kind: 'harness',
							supportsFork: true,
							supportsImages: false,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-chat-completions'],
							defaultModel: 'gpt-5.3-codex',
							models: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsImages: false }]
						},
						{
							id: 'factory',
							label: 'Factory',
							kind: 'harness',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'claude-opus-4-6',
							models: [{ value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true }]
						}
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
									exposeTo: ['claude'],
									defaultModel: 'glm-5.1',
									models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
									supportsImages: false,
									hasApiKey: true,
									modelDiscovery: 'none'
								}
							]
						}
					]
				}
			})
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
					harnesses: [
						{
							id: 'codex',
							label: 'Codex',
							kind: 'harness',
							supportsFork: true,
							supportsImages: false,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-chat-completions'],
							defaultModel: 'gpt-5.3-codex',
							models: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }]
						}
					],
					apiProviders: []
				}
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		const codexModels = store.getModels('codex');
		expect(codexModels[0]).toMatchObject({ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' });
		expect(codexModels.find((m) => m.value === 'gpt-5.5')).toBeTruthy();
		expect(codexModels.length).toBeGreaterThan(1);
	});

	it('records an error for invalid catalog responses', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({ claude: [{ value: 'opus', label: 'Opus' }] })
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.error).toBe('Model catalog response is invalid');
		expect(store.getModels('claude').find((m) => m.value === 'sonnet')).toBeTruthy();
	});

	it('prefers model-level image capability when present', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					harnesses: [
						{
							id: 'factory',
							label: 'Factory',
							kind: 'harness',
							supportsFork: false,
							supportsImages: false,
							acceptsApiProviderEndpoints: false,
							supportedProtocols: [],
							defaultModel: 'claude-opus-4-6',
							models: [
								{ value: 'claude-opus-4-6', label: 'Claude Opus 4.6', supportsImages: true },
								{ value: 'glm-5', label: 'Droid Core (GLM-5)', supportsImages: false }
							]
						}
					],
					apiProviders: []
				}
			})
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
					harnesses: [
							{
								id: 'direct-openai-compatible',
								label: 'Direct Chat (OpenAI)',
							kind: 'harness',
							supportsFork: false,
							supportsImages: true,
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-chat-completions'],
							defaultModel: 'zai_openai:glm-5.1',
							models: [
								{
									value: 'zai_openai:glm-5.1',
									label: 'Z.AI: GLM-5.1',
									rawModel: 'glm-5.1',
									apiProviderId: 'zai',
									endpointId: 'zai_openai',
									protocol: 'openai-chat-completions',
									supportsImages: false
								}
							]
						}
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
									protocol: 'openai-chat-completions',
									baseUrl: 'https://api.z.ai/api/coding/paas/v4',
									exposeTo: ['direct-openai-compatible'],
									defaultModel: 'glm-5.1',
									models: [{ value: 'glm-5.1', label: 'GLM-5.1' }],
									supportsImages: false,
									hasApiKey: true,
									modelDiscovery: 'none'
								}
							]
						}
					]
				}
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.selectionFor('direct-openai-compatible', 'zai_openai:glm-5.1')).toEqual({
			model: 'glm-5.1',
			apiProviderId: 'zai',
			modelEndpointId: 'zai_openai',
			modelProtocol: 'openai-chat-completions'
		});
		expect(store.selectionValueFor('direct-openai-compatible', 'glm-5.1', 'zai_openai'))
			.toBe('zai_openai:glm-5.1');
		expect(store.supportsImages('direct-openai-compatible', 'glm-5.1', 'zai_openai')).toBe(false);
			expect(store.findEndpoint('zai_openai')?.endpoint.defaultModel).toBe('glm-5.1');
		});

		it('maps Direct Anthropic endpoint selections to raw models', async () => {
			vi.mocked(clientApi.apiFetch).mockResolvedValue({
				ok: true,
				json: async () => ({
					catalog: {
						harnesses: [
							{
								id: 'direct-anthropic-compatible',
								label: 'Direct Chat (Anthropic)',
								kind: 'harness',
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
										supportsImages: true
									}
								]
							}
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
										exposeTo: ['direct-anthropic-compatible'],
										defaultModel: 'acme-sonnet',
										models: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
										supportsImages: true,
										hasApiKey: true,
										modelDiscovery: 'anthropic-models'
									}
								]
							}
						]
					}
				})
			} as unknown as Response);

			const store = createModelCatalogStore();
			await store.forceRefresh();

			expect(store.getSelectableHarnesses()).toContain('direct-anthropic-compatible');
			expect(store.selectionFor('direct-anthropic-compatible', 'acme_anthropic:acme-sonnet')).toEqual({
				model: 'acme-sonnet',
				apiProviderId: 'acme',
				modelEndpointId: 'acme_anthropic',
				modelProtocol: 'anthropic-messages'
			});
			expect(store.selectionValueFor('direct-anthropic-compatible', 'acme-sonnet', 'acme_anthropic'))
				.toBe('acme_anthropic:acme-sonnet');
			expect(store.supportsImages('direct-anthropic-compatible', 'acme-sonnet', 'acme_anthropic')).toBe(true);
			expect(store.findEndpoint('acme_anthropic')?.endpoint.defaultModel).toBe('acme-sonnet');
		});
	});
