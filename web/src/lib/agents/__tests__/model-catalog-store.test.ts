import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientApi from '$lib/api/client';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import { createModelCatalogStore as createCatalog } from '../model-catalog-store.svelte';
import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';

vi.mock('$lib/api/client', async (importOriginal) => ({
	...await importOriginal<typeof clientApi>(),
	apiFetch: vi.fn(),
}));

function createModelCatalogStore() {
	const catalog = createCatalog();
	catalog.setOwner('test-owner');
	return catalog;
}

const STORAGE_KEY = LOCAL_STORAGE_KEYS.modelCatalog;

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
		executionPolicy: 'conversation',
		selectionLabel: 'Model', inputFormatByModel: {},
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
	it('retains selection-specific input formats through cold hydration', async () => {
		localStorage.clear();
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agentEntry('shell', {
			executionPolicy: 'literal', inputFormatByModel: { 'notes-markdown': 'markdown' },
		})])));
		await createModelCatalogStore().forceRefresh();
		expect(createModelCatalogStore().getAgent('shell')?.inputFormatByModel).toEqual({ 'notes-markdown': 'markdown' });
	});
	beforeEach(() => {
		localStorage.clear();
		vi.mocked(clientApi.apiFetch).mockReset();
	});

	it.each(['local', remoteExecutor.id])('invalidates a recent cache without execution policy on %s', (executorId) => {
		const cached = {
			agentModels: { shell: [{ value: 'sh', label: 'Sh' }] },
			agentMetadata: { shell: agentEntry('shell') }, apiProviderCatalog: [],
			lastFetchedAt: Date.now(), lastValidatedAt: Date.now(),
		};
		localStorage.setItem(executorId === 'local' ? STORAGE_KEY : LOCAL_STORAGE_KEYS.modelCatalogExecutors,
			JSON.stringify(executorId === 'local' ? cached : { [executorId]: cached }));
		const catalog = createModelCatalogStore().forExecutor(executorId);
		expect(catalog.getAgent('shell')).toBeNull();
		expect(catalog.isStale()).toBe(true);
	});

	it('isolates identical agent/model identities by executor in requests and persisted catalogs', async () => {
		const store = createModelCatalogStore();
		const remote = store.forExecutor(remoteExecutor.id);
		vi.mocked(clientApi.apiFetch)
			.mockResolvedValueOnce(mockResponse(catalogBody([agentEntry('sample', {
				models: [{ value: 'same', label: 'Local model' }],
			})])))
			.mockResolvedValueOnce(mockResponse(catalogBody([agentEntry('sample', {
				models: [{ value: 'same', label: 'Worker model' }],
			})])));
		await store.forceRefresh();
		await remote.forceRefresh();
		expect(clientApi.apiFetch).toHaveBeenNthCalledWith(1, '/api/v1/models', { cache: 'no-store' });
		expect(clientApi.apiFetch).toHaveBeenNthCalledWith(2, `/api/v1/models?executorId=${remoteExecutor.id}`, { cache: 'no-store' });
		expect(store.getModels('sample')[0]?.label).toBe('Local model');
		expect(remote.getModels('sample')[0]?.label).toBe('Worker model');
		const restored = createModelCatalogStore();
		expect(restored.getModels('sample')[0]?.label).toBe('Local model');
		expect(restored.forExecutor(remoteExecutor.id).getModels('sample')[0]?.label).toBe('Worker model');
	});

	it.each(['local', remoteExecutor.id])('fences ordinary %s discovery in memory and on disk across an owner switch', async executorId => {
		const catalog = createModelCatalogStore();
		const worker = catalog.forExecutor(executorId);
		const old = catalogBody([agentEntry('old-owner-only')]);
		const response = Promise.withResolvers<Response>();
		vi.mocked(clientApi.apiFetch).mockResolvedValueOnce(mockResponse(old)).mockReturnValueOnce(response.promise);
		await worker.forceRefresh();
		const late = worker.forceRefresh();
		const reloaded = createCatalog();
		reloaded.setOwner('new-owner');
		expect(reloaded.forExecutor(executorId).getAgent('old-owner-only')).toBeNull();
		catalog.setOwner('new-owner');
		response.resolve(mockResponse(old));
		await late;
		expect(worker.getAgent('old-owner-only')).toBeNull();
		expect(worker.isValidated).toBe(false);
		expect(localStorage.getItem(executorId === 'local' ? STORAGE_KEY : LOCAL_STORAGE_KEYS.modelCatalogExecutors)).toBeNull();
	});

	describe.each(['local', remoteExecutor.id])('execution metadata on %s', executorId => {
		it.each(['conversation', 'literal'])('retains %s policy and label across cold hydration', async executionPolicy => {
			const selectionLabel = executionPolicy === 'literal' ? 'Shell' : 'Model';
			const entry = agentEntry('sample', { executionPolicy, selectionLabel });
			vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([entry])));
			await createModelCatalogStore().forExecutor(executorId).forceRefresh();
			const restored = createModelCatalogStore().forExecutor(executorId);
			expect(restored.getAgent('sample')).toMatchObject({ executionPolicy, selectionLabel });
			expect(restored.isValidated).toBe(false);
		});

		it.each([
			{ executionPolicy: undefined }, { executionPolicy: 'unknown' },
			{ selectionLabel: undefined }, { selectionLabel: '', inputFormatByModel: {} },
		])('rejects incomplete HTTP and persisted metadata: %j', async missing => {
			const entry = agentEntry('sample', missing);
			const cached = { schemaVersion: 2, owner: 'test-owner', agentMetadata: { sample: entry },
				agentModels: { sample: [{ value: 'cached', label: 'Cached' }] }, apiProviderCatalog: [],
				etag: 'old-etag', lastFetchedAt: Date.now(), lastValidatedAt: Date.now() };
			localStorage.setItem(executorId === 'local' ? STORAGE_KEY : LOCAL_STORAGE_KEYS.modelCatalogExecutors,
				JSON.stringify(executorId === 'local' ? cached : { [executorId]: cached }));
			const catalog = createModelCatalogStore().forExecutor(executorId);
			expect(catalog.getAgent('sample')).toBeNull();
			expect(catalog.getModels('sample')).toEqual([]);
			expect(catalog.isValidated).toBe(false);
			vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([entry])));
			await catalog.forceRefresh();
			expect(catalog.getAgent('sample')).toBeNull();
			expect(catalog.error).toBe('Model catalog response is invalid');
			expect(catalog.isValidated).toBe(false);
			expect(clientApi.apiFetch).toHaveBeenLastCalledWith(executorId === 'local'
				? '/api/v1/models' : `/api/v1/models?executorId=${executorId}`, { cache: 'no-store' });
		});
	});

	it('fences a pending catalog request when its executor disconnects or is deleted', async () => {
		const store = createModelCatalogStore();
		const remote = store.forExecutor(remoteExecutor.id);
		store.reconcileExecutors([localExecutor, remoteExecutor]);
		const response = Promise.withResolvers<Response>();
		vi.mocked(clientApi.apiFetch).mockReturnValue(response.promise);
		const pending = remote.forceRefresh();
		store.reconcileExecutors([localExecutor]);
		response.resolve(mockResponse(catalogBody([agentEntry('sample', {
			models: [{ value: 'late', label: 'Stale model' }],
		})])));
		await pending;
		expect(remote.isRefreshing).toBe(false);
		expect(remote.getModels('sample')).toEqual([]);
		expect(store.forExecutor(remoteExecutor.id)).not.toBe(remote);
		expect(localStorage.getItem(LOCAL_STORAGE_KEYS.modelCatalogExecutors)).toBeNull();
	});

	it('does not rewrite persisted snapshots for equivalent executor inventories', async () => {
		const store = createModelCatalogStore();
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agentEntry('sample')])));
		await store.forExecutor(remoteExecutor.id).forceRefresh();
		const write = vi.spyOn(localStorage, 'setItem');
		store.reconcileExecutors([localExecutor, remoteExecutor]);
		store.reconcileExecutors([localExecutor, { ...remoteExecutor }]);
		expect(write).not.toHaveBeenCalled();
		store.reconcileExecutors([localExecutor]);
		expect(write).toHaveBeenCalledOnce();
		write.mockRestore();
	});

	it('starts empty instead of embedding integration-specific fallbacks', () => {
		const store = createModelCatalogStore();

		expect(store.getSelectableAgents()).toEqual([]);
		expect(store.getModels('claude')).toEqual([]);
		expect(store.supportsFork('claude')).toBe(false);
		expect(store.supportsSteering('claude')).toBe(false);
		expect(store.getPermissionModes('claude')).toEqual([]);
		expect(store.getThinkingModes('claude')).toEqual([]);
	});

	it('invalidates only the replaced executor catalog when the browser missed offline', async () => {
		const store = createModelCatalogStore();
		const remote = store.forExecutor(remoteExecutor.id);
		store.reconcileExecutors([localExecutor, remoteExecutor]);
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agentEntry('sample', {
			models: [{ value: 'same', label: 'Cached model' }],
		})])));
		await store.forceRefresh(); await remote.forceRefresh();
		const stale = Promise.withResolvers<Response>();
		vi.mocked(clientApi.apiFetch).mockReturnValueOnce(stale.promise);
		const loading = remote.forceRefresh();
		store.reconcileExecutors([localExecutor, { ...remoteExecutor, instanceId: 'replacement' }]);
		expect(store.isValidated).toBe(true);
		expect(remote.isValidated).toBe(false);
		expect(remote.getModels('sample')[0]?.value).toBe('same');
		stale.resolve(mockResponse(catalogBody([agentEntry('sample', { models: [{ value: 'stale', label: 'Stale' }] })])));
		await loading;
		expect(remote.getModels('sample')[0]?.value).toBe('same');
		expect(createModelCatalogStore().forExecutor(remoteExecutor.id).isValidated).toBe(false);
	});

	it('invalidates live and uninstantiated persisted executor catalogs after global provider changes', async () => {
		const original = createModelCatalogStore();
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agentEntry('sample', {
			models: [{ value: 'cached', label: 'Cached Model' }],
		})])));
		await original.forceRefresh();
		await original.forExecutor(remoteExecutor.id).forceRefresh();
		const store = createModelCatalogStore();
		expect(store.isValidated).toBe(false);
		store.invalidateAll();
		expect(store.isValidated).toBe(false);
		expect(store.getModels('sample')).toHaveLength(1);
		expect(store.forExecutor(remoteExecutor.id).isValidated).toBe(false);
		const restored = createModelCatalogStore();
		expect(restored.isValidated).toBe(false);
		expect(restored.forExecutor(remoteExecutor.id).isValidated).toBe(false);
	});

	it('keeps an in-flight Local catalog request when the first executor snapshot arrives', async () => {
		const response = Promise.withResolvers<Response>();
		vi.mocked(clientApi.apiFetch).mockReturnValue(response.promise);
		const store = createModelCatalogStore();
		const pending = store.forceRefresh();
		store.reconcileExecutors([localExecutor, remoteExecutor]);
		response.resolve(mockResponse(catalogBody([agentEntry('sample', {
			models: [{ value: 'same', label: 'Local model' }],
		})])));
		await pending;
		expect(store.getModels('sample')[0]?.label).toBe('Local model');
		expect(store.isStale()).toBe(false);
	});

	it.each([false, true])('invalidates persisted remote catalogs on reconnect (instantiated: %s)', async (instantiate) => {
		const initial = createModelCatalogStore();
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agentEntry('sample', {
			models: [{ value: 'same', label: 'Worker model' }],
		})])));
		await initial.forExecutor(remoteExecutor.id).forceRefresh();
		const store = createModelCatalogStore();
		if (instantiate) expect(store.forExecutor(remoteExecutor.id).isStale()).toBe(true);
		store.reconcileExecutors([localExecutor, { ...remoteExecutor, availability: 'offline' }]);
		store.reconcileExecutors([localExecutor, remoteExecutor]);
		expect(store.forExecutor(remoteExecutor.id).isStale()).toBe(true);
		expect(createModelCatalogStore().forExecutor(remoteExecutor.id).isStale()).toBe(true);
	});

	it('retains the remote schema and literal policy through reconciliation and cold hydration', async () => {
		const store = createModelCatalogStore();
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agentEntry('sample', {
			executionPolicy: 'literal',
		})])));
		await store.forExecutor(remoteExecutor.id).forceRefresh();
		store.reconcileExecutors([localExecutor, remoteExecutor]);
		const restored = createModelCatalogStore().forExecutor(remoteExecutor.id);
		expect(restored.isValidated).toBe(false);
		expect(restored.getAgent('sample')?.executionPolicy).toBe('literal');
	});

	it.each([false, true])('compares hydrated catalogs to the first worker inventory (already mounted: %s)', async mounted => {
		const initial = createModelCatalogStore();
		const agent = agentEntry('sample', { models: [{ label: 'Previous', value: 'previous' }] });
		vi.mocked(clientApi.apiFetch).mockResolvedValue(mockResponse(catalogBody([agent]), 200, {
			'X-Garcon-Executor-Instance': remoteExecutor.instanceId,
		}));
		await initial.forExecutor(remoteExecutor.id).forceRefresh();
		const restored = createModelCatalogStore();
		if (mounted) expect(restored.forExecutor(remoteExecutor.id).isValidated).toBe(false);
		restored.reconcileExecutors([remoteExecutor]);
		expect(restored.forExecutor(remoteExecutor.id).isValidated).toBe(true);
		const replaced = createModelCatalogStore();
		if (mounted) replaced.forExecutor(remoteExecutor.id);
		replaced.reconcileExecutors([{ ...remoteExecutor, instanceId: 'replacement' }]);
		expect(replaced.forExecutor(remoteExecutor.id).isValidated).toBe(false);
		expect(replaced.forExecutor(remoteExecutor.id).isStale()).toBe(true);
	});

	it('hydrates models, capabilities, modes, and settings from storage', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				schemaVersion: 2, owner: 'test-owner',
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
								labelKey: 'thinking',
								options: [
									{
										value: 'high',
										label: 'High',
										labelKey: 'enabled',
										description: 'Uses extended thinking for every response.',
										descriptionKey: 'thinkingEnabled',
									},
								],
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
		expect(store.supportsSteering('sample')).toBe(false);
		expect(store.getPermissionModes('sample')).toEqual(['default', 'manualBypass']);
		expect(store.getThinkingModes('sample')).toEqual(['none', 'high']);
		expect(store.getAgentSettingsDescriptors('sample')).toEqual([
			expect.objectContaining({
				key: 'effort',
				type: 'enum',
				labelKey: 'thinking',
				options: [
					expect.objectContaining({
						value: 'high',
						labelKey: 'enabled',
						description: 'Uses extended thinking for every response.',
						descriptionKey: 'thinkingEnabled',
					}),
				],
			}),
		]);
		expect(store.getDefaultAgentSettings('sample')).toEqual({
			ownerId: 'sample',
			schemaVersion: 2,
			values: { effort: 'high' },
		});
	});

	it('revalidates an ETag without replacing the hydrated catalog', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				schemaVersion: 2, owner: 'test-owner',
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
			cache: 'no-store',
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

	it('revalidates a failed ordinary refresh on demand after the retry throttle', async () => {
		vi.useFakeTimers();
		try {
			const store = createModelCatalogStore();
			const ready = () => mockResponse(catalogBody([agentEntry('sample')]));
			vi.mocked(clientApi.apiFetch)
				.mockResolvedValueOnce(ready())
				.mockRejectedValueOnce(new clientApi.ApiError(429, 'Executor busy', 'EXECUTOR_BUSY'))
				.mockResolvedValueOnce(ready());
			await store.forceRefresh();
			await store.forceRefresh();
			expect(store.isValidated).toBe(false);
			await store.refreshIfStale();
			expect(clientApi.apiFetch).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(60_000);
			await store.refreshIfStale();
			expect(clientApi.apiFetch).toHaveBeenCalledTimes(3);
			expect(store.isValidated).toBe(true);
		} finally { vi.useRealTimers(); }
	});

	it('skips validation while the catalog is inside the requested TTL', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				schemaVersion: 2, owner: 'test-owner', instanceId: localExecutor.instanceId,
				agentModels: { sample: [{ value: 'cached', label: 'Cached' }] },
				agentMetadata: { sample: agentEntry('sample', { defaultModel: 'cached' }) },
				apiProviderCatalog: [],
				lastFetchedAt: Date.now(),
			}),
		);
		vi.mocked(clientApi.apiFetch).mockResolvedValue(
			mockResponse(catalogBody([agentEntry('sample')])),
		);
		const store = createModelCatalogStore();

		store.reconcileExecutors([localExecutor]);
		await store.refreshIfStale(60_000);
		expect(clientApi.apiFetch).not.toHaveBeenCalled();

		await store.refreshIfStale(0);
		expect(clientApi.apiFetch).toHaveBeenCalledTimes(1);
	});

	it('treats the server catalog as authoritative for integrations and capabilities', async () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				schemaVersion: 2, owner: 'test-owner',
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
						supportsSteering: true,
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

		expect(store.getSelectableAgents()).toEqual(['sample-agent']);
		expect(store.getAgent('stale')).toBeNull();
		expect(store.supportsFork('sample-agent')).toBe(true);
		expect(store.supportsForkAtMessage('sample-agent')).toBe(true);
		expect(store.supportsSteering('sample-agent')).toBe(true);
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
				schemaVersion: 2, owner: 'test-owner',
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
							revision: 1,
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

	it('treats an explicit endpoint as a hard constraint when resolving selections', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				schemaVersion: 2, owner: 'test-owner',
				agentModels: {
					sample: [
						{ value: 'sol', label: 'Sol' },
						{ value: 'luna', label: 'Luna' },
						{
							value: 'acme-openai:sonnet',
							label: 'Acme: Sonnet',
							rawModel: 'sonnet',
							apiProviderId: 'acme',
							endpointId: 'acme-openai',
							protocol: 'openai-compatible',
						},
						{
							value: 'acme-openai:retired-native',
							label: 'Acme: Retired Native',
							rawModel: 'retired-native',
							apiProviderId: 'acme',
							endpointId: 'acme-openai',
							protocol: 'openai-compatible',
						},
					],
				},
				agentMetadata: { sample: agentEntry('sample', { defaultModel: 'sol' }) },
				apiProviderCatalog: [],
				lastFetchedAt: Date.now(),
			}),
		);

		const store = createModelCatalogStore();

		expect(store.getModelForSelection('sample', 'luna')?.value).toBe('luna');
		expect(store.getModelForSelection('sample', 'sonnet', 'acme-openai')?.value).toBe(
			'acme-openai:sonnet',
		);
		// A model the endpoint no longer exposes stays unresolvable instead of
		// silently re-targeting the native model sharing its raw name.
		expect(store.getModelForSelection('sample', 'luna', 'acme-openai')).toBeNull();
		expect(store.selectionFor('sample', 'luna', 'acme-openai')).toBeNull();
		// An unscoped persisted name denotes a native model, not an endpoint
		// that happens to expose the same raw name.
		expect(store.getModelForSelection('sample', 'retired-native', null)).toBeNull();
		expect(
			store.getModelForSelection('sample', 'acme-openai:retired-native', null),
		).toBeNull();
		expect(store.selectionFor('sample', 'retired-native', null)).toEqual({
			model: 'retired-native',
			apiProviderId: null,
			modelEndpointId: null,
			modelProtocol: null,
		});
		expect(store.selectionFor('sample', 'acme-openai:retired-native')).toMatchObject({
			model: 'retired-native',
			apiProviderId: 'acme',
			modelEndpointId: 'acme-openai',
		});
	});

	it('ignores malformed integration ids from persisted data', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				schemaVersion: 2, owner: 'test-owner',
				agentModels: { 'Bad Id': [{ value: 'bad', label: 'Bad' }] },
				agentMetadata: { 'Bad Id': agentEntry('Bad Id', { defaultModel: 'bad' }) },
				apiProviderCatalog: [],
			}),
		);

		const store = createModelCatalogStore();

		expect(store.getSelectableAgents()).toEqual([]);
		expect(store.getModels('Bad Id')).toEqual([]);
	});
});
