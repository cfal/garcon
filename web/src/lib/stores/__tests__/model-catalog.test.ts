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
});
