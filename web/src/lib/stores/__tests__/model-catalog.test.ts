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
		expect(store.getDefaultModel('claude')).toBe('opus');
	});

	it('exposes default capabilities from common contract', () => {
		const store = createModelCatalogStore();
		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsFork('codex')).toBe(true);
		expect(store.supportsFork('opencode')).toBe(false);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(true);
		expect(store.supportsImages('opencode')).toBe(false);
	});

	it('hydrates cached models from localStorage', () => {
		localStorage.setItem(
			'pref_model_catalog',
			JSON.stringify({
				providerModels: {
					opencode: [{ value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' }]
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

	it('hydrates cached capabilities from localStorage', () => {
		localStorage.setItem(
			'pref_model_catalog',
			JSON.stringify({
				providerModels: {},
				providerCapabilities: {
					claude: { supportsFork: true, supportsImages: true },
					codex: { supportsFork: true, supportsImages: false },
					opencode: { supportsFork: false, supportsImages: false },
				},
				lastFetchedAt: Date.now()
			})
		);

		const store = createModelCatalogStore();
		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(false);
	});

	it('refreshes when stale and persists merged results', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				opencode: [{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }]
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.refreshIfStale(0);

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models');
		expect(store.getModels('opencode')).toEqual([{ value: 'moonshot/kimi-k2', label: 'Kimi K2' }]);
		expect(store.getModels('claude').length).toBeGreaterThan(0);
		expect(store.getModels('codex').length).toBeGreaterThan(0);
	});

	it('parses catalog.providers from API response', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				claude: [{ value: 'opus', label: 'Opus' }],
				codex: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }],
				opencode: [],
				catalog: {
					providers: [
						{
							id: 'claude',
							supportsFork: true,
							supportsImages: true,
							models: [{ value: 'opus', label: 'Opus' }],
						},
						{
							id: 'codex',
							supportsFork: true,
							supportsImages: false,
							models: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }],
						},
						{
							id: 'opencode',
							supportsFork: false,
							supportsImages: false,
							models: [],
						},
					],
				},
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsFork('opencode')).toBe(false);
		expect(store.supportsImages('claude')).toBe(true);
		expect(store.supportsImages('codex')).toBe(false);
		// Remote had only opus; static sonnet+haiku are appended
		const claudeModels = store.getModels('claude');
		expect(claudeModels[0]).toEqual({ value: 'opus', label: 'Opus' });
		expect(claudeModels.find((m) => m.value === 'sonnet')).toBeTruthy();
	});

	it('merges missing static models into cached results', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				catalog: {
					providers: [
						{
							id: 'codex',
							supportsFork: true,
							supportsImages: false,
							models: [{ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }],
						},
					],
				},
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		const codexModels = store.getModels('codex');
		expect(codexModels[0]).toEqual({ value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' });
		// Static gpt-5.4 should be appended
		expect(codexModels.find((m) => m.value === 'gpt-5.4')).toBeTruthy();
		expect(codexModels.length).toBeGreaterThan(1);
	});

	it('falls back to legacy shape when catalog is absent', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				claude: [{ value: 'opus', label: 'Opus' }],
				codex: [],
				opencode: [],
			})
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		// Remote had only opus; static sonnet+haiku are merged in
		const claudeModels = store.getModels('claude');
		expect(claudeModels[0]).toEqual({ value: 'opus', label: 'Opus' });
		expect(claudeModels.find((m) => m.value === 'sonnet')).toBeTruthy();
		// Falls back to default capabilities from common contract
		expect(store.supportsFork('claude')).toBe(true);
		expect(store.supportsImages('claude')).toBe(true);
	});
});
