import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientApi from '$lib/api/client';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { createModelCatalogStore } from '../model-catalog.svelte';

vi.mock('$lib/api/client', () => ({
	apiFetch: vi.fn(),
}));

const STORAGE_KEY = LOCAL_STORAGE_KEYS.modelCatalog;
const LEGACY_STORAGE_KEY = LOCAL_STORAGE_KEYS.modelCatalogLegacy;

function mockResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(headers),
		json: async () => body,
	} as Response;
}

function agentEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		label: id,
		kind: 'agent',
		supportsFork: false,
		supportsForkAtMessage: false,
		supportsForkWhileRunning: false,
		supportsUpdateProjectPath: false,
		supportsImages: false,
		acceptsApiProviderEndpoints: false,
		supportedProtocols: [],
		authLoginSupported: false,
		supportedPermissionModes: ['default'],
		supportedThinkingModes: ['none'],
		settings: [],
		defaultSettings: { ownerId: id, schemaVersion: 1, values: {} },
		defaultModel: '',
		models: [],
		...overrides,
	};
}

function catalogBody(agents: unknown[], apiProviders: unknown[] = []): unknown {
	return { catalog: { agents, apiProviders } };
}

describe('ModelCatalogStore', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(clientApi.apiFetch).mockReset();
	});

	it('starts empty instead of embedding integration-specific fallbacks', () => {
		const store = createModelCatalogStore();

		expect(store.getAgents()).toEqual([]);
		expect(store.getModels('claude')).toEqual([]);
		expect(store.supportsFork('claude')).toBe(false);
		expect(store.getPermissionModes('claude')).toEqual([]);
		expect(store.getThinkingModes('claude')).toEqual([]);
	});

	it('hydrates models, capabilities, modes, and settings from storage', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: { sample: [{ value: 'sample-model', label: 'Sample Model' }] },
				agentMetadata: {
					sample: agentEntry('sample', {
						label: 'Sample',
						supportsFork: true,
						supportedPermissionModes: ['default', 'manualBypass', 'invalid'],
						supportedThinkingModes: ['none', 'high', 'invalid'],
						settings: [
							{
								key: 'effort',
								type: 'enum',
								label: 'Effort',
								options: [{ value: 'high', label: 'High' }],
							},
						],
						defaultSettings: {
							ownerId: 'sample',
							schemaVersion: 2,
							values: { effort: 'high' },
						},
						defaultModel: 'sample-model',
					}),
				},
				apiProviderCatalog: [],
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();

		expect(store.getSelectableAgents()).toEqual(['sample']);
		expect(store.getModels('sample')).toEqual([{ value: 'sample-model', label: 'Sample Model' }]);
		expect(store.supportsFork('sample')).toBe(true);
		expect(store.getPermissionModes('sample')).toEqual(['default', 'manualBypass']);
		expect(store.getThinkingModes('sample')).toEqual(['none', 'high']);
		expect(store.getAgentSettingsDescriptors('sample')).toEqual([
			expect.objectContaining({ key: 'effort', type: 'enum' }),
		]);
		expect(store.getDefaultAgentSettings('sample')).toEqual({
			ownerId: 'sample',
			schemaVersion: 2,
			values: { effort: 'high' },
		});
	});

	it('loads the previous catalog schema and validates it against the server', async () => {
		localStorage.setItem(
			LEGACY_STORAGE_KEY,
			JSON.stringify({
				agentModels: { sample: [{ value: 'old-model', label: 'Old Model' }] },
				agentMetadata: {
					sample: agentEntry('sample', { defaultModel: 'old-model' }),
				},
				apiProviderCatalog: [],
				lastFetchedAt: Date.now(),
			}),
		);
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(
			mockResponse(
				catalogBody([
					agentEntry('sample', {
						defaultModel: 'new-model',
						models: [{ value: 'new-model', label: 'New Model' }],
					}),
				]),
				200,
				{ etag: 'W/"catalog:new"' },
			),
		);

		const store = createModelCatalogStore();
		expect(store.getDefaultModel('sample')).toBe('old-model');

		await store.refreshIfStale();

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models');
		expect(store.getDefaultModel('sample')).toBe('new-model');
		expect(store.etag).toBe('W/"catalog:new"');
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').etag).toBe('W/"catalog:new"');
	});

	it('revalidates an ETag without replacing the hydrated catalog', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: { sample: [{ value: 'cached', label: 'Cached' }] },
				agentMetadata: { sample: agentEntry('sample', { defaultModel: 'cached' }) },
				apiProviderCatalog: [],
				etag: 'W/"catalog:cached"',
				lastFetchedAt: 100,
				lastValidatedAt: 100,
			}),
		);
		const json = vi.fn();
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce({
			ok: false,
			status: 304,
			headers: new Headers({ etag: 'W/"catalog:cached"' }),
			json,
		} as unknown as Response);

		const store = createModelCatalogStore();
		await store.refreshIfStale();

		expect(clientApi.apiFetch).toHaveBeenCalledWith('/api/v1/models', {
			headers: { 'If-None-Match': 'W/"catalog:cached"' },
		});
		expect(json).not.toHaveBeenCalled();
		expect(store.getDefaultModel('sample')).toBe('cached');
		expect(store.lastValidatedAt).toEqual(expect.any(Number));
	});

	it('coalesces validation attempts inside the retry window', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValue(
			mockResponse(catalogBody([agentEntry('sample')])),
		);
		const store = createModelCatalogStore();

		await store.refreshIfStale();
		await store.refreshIfStale();

		expect(clientApi.apiFetch).toHaveBeenCalledTimes(1);
	});

	it('treats the server catalog as authoritative for integrations and capabilities', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: { stale: [{ value: 'stale', label: 'Stale' }] },
				agentMetadata: { stale: agentEntry('stale', { defaultModel: 'stale' }) },
				apiProviderCatalog: [],
			}),
		);
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(
			mockResponse(
				catalogBody([
					agentEntry('sample-agent', {
						label: 'Sample Agent',
						supportsFork: true,
						supportsForkAtMessage: true,
						supportsUpdateProjectPath: true,
						supportsImages: true,
						supportedPermissionModes: ['default', 'plan'],
						supportedThinkingModes: ['none', 'ultra'],
						settings: [
							{
								key: 'sandbox',
								type: 'boolean',
								label: 'Sandbox',
							},
						],
						defaultSettings: {
							ownerId: 'sample-agent',
							schemaVersion: 3,
							values: { sandbox: true },
						},
						defaultModel: 'sample-model',
						models: [{ value: 'sample-model', label: 'Sample Model' }],
					}),
				]),
			),
		);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.getAgents()).toEqual(['sample-agent']);
		expect(store.getAgent('stale')).toBeNull();
		expect(store.supportsFork('sample-agent')).toBe(true);
		expect(store.supportsForkAtMessage('sample-agent')).toBe(true);
		expect(store.supportsUpdateProjectPath('sample-agent')).toBe(true);
		expect(store.supportsImages('sample-agent')).toBe(true);
		expect(store.getPermissionModes('sample-agent')).toEqual(['default', 'plan']);
		expect(store.getThinkingModes('sample-agent')).toEqual(['none', 'ultra']);
		expect(store.getDefaultAgentSettings('sample-agent')).toEqual({
			ownerId: 'sample-agent',
			schemaVersion: 3,
			values: { sandbox: true },
		});
	});

	it('accepts integrations with no currently available models', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(
			mockResponse(catalogBody([agentEntry('model-less')])),
		);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.error).toBeNull();
		expect(store.getSelectableAgents()).toEqual(['model-less']);
		expect(store.getModels('model-less')).toEqual([]);
	});

	it('preserves hydrated data when a refresh response is invalid', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: { sample: [{ value: 'cached', label: 'Cached' }] },
				agentMetadata: { sample: agentEntry('sample', { defaultModel: 'cached' }) },
				apiProviderCatalog: [],
			}),
		);
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(mockResponse({ catalog: { agents: [] } }));

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.error).toBe('Model catalog response is invalid');
		expect(store.getDefaultModel('sample')).toBe('cached');
	});

	it('prefers model-level image capability over the integration default', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(
			mockResponse(
				catalogBody([
					agentEntry('sample', {
						supportsImages: false,
						defaultModel: 'image-model',
						models: [
							{ value: 'image-model', label: 'Image Model', supportsImages: true },
							{ value: 'text-model', label: 'Text Model', supportsImages: false },
						],
					}),
				]),
			),
		);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.supportsImages('sample', 'image-model')).toBe(true);
		expect(store.supportsImages('sample', 'text-model')).toBe(false);
		expect(store.supportsImages('sample', 'unknown')).toBe(false);
	});

	it('preserves endpoint metadata and maps selection values to raw models', async () => {
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(
			mockResponse(
				catalogBody(
					[
						agentEntry('sample', {
							acceptsApiProviderEndpoints: true,
							supportedProtocols: ['openai-compatible'],
							defaultModel: 'acme-openai:acme-code',
							models: [
								{
									value: 'acme-openai:acme-code',
									label: 'Acme Code',
									rawModel: 'acme-code',
									apiProviderId: 'acme',
									endpointId: 'acme-openai',
									protocol: 'openai-compatible',
									supportsImages: true,
								},
							],
						}),
					],
					[
						{
							id: 'acme',
							label: 'Acme',
							templateId: 'custom',
							createdAt: '2026-01-01T00:00:00.000Z',
							updatedAt: '2026-01-01T00:00:00.000Z',
							endpoints: [
								{
									id: 'acme-openai',
									protocol: 'openai-compatible',
									baseUrl: 'https://api.acme.test/v1',
									capabilities: { chatCompletions: false, responses: true },
									defaultModel: 'acme-code',
									models: [{ value: 'acme-code', label: 'Acme Code' }],
									supportsImages: true,
									hasApiKey: true,
									modelDiscovery: 'openai-models',
								},
							],
						},
					],
				),
			),
		);

		const store = createModelCatalogStore();
		await store.forceRefresh();

		expect(store.selectionFor('sample', 'acme-openai:acme-code')).toEqual({
			model: 'acme-code',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-openai',
			modelProtocol: 'openai-compatible',
		});
		expect(store.selectionValueFor('sample', 'acme-code', 'acme-openai')).toBe(
			'acme-openai:acme-code',
		);
		expect(store.supportsImages('sample', 'acme-code', 'acme-openai')).toBe(true);
		expect(store.findEndpoint('acme-openai')?.endpoint.capabilities).toEqual({
			chatCompletions: false,
			responses: true,
		});
	});

	it('ignores malformed integration ids from persisted data', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				agentModels: { 'Bad Id': [{ value: 'bad', label: 'Bad' }] },
				agentMetadata: { 'Bad Id': agentEntry('Bad Id', { defaultModel: 'bad' }) },
				apiProviderCatalog: [],
			}),
		);

		const store = createModelCatalogStore();

		expect(store.getAgents()).toEqual([]);
		expect(store.getModels('Bad Id')).toEqual([]);
	});
});
