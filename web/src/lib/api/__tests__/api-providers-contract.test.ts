import { afterEach, expect, it, vi } from 'vitest';
import { assignApiProvider, createApiProvider, deleteApiProvider, discoverApiProviderModels, getApiProviderManagement, testApiProvider, unassignApiProvider, updateApiProvider } from '../api-providers';

afterEach(() => vi.unstubAllGlobals());

it.each(['local', '22222222-2222-4222-8222-222222222222'])('qualifies endpoint test and model discovery by %s', async (executorId) => {
	const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
	const request = {
		protocol: 'openai-compatible' as const, baseUrl: 'http://localhost:11434/v1',
		modelDiscovery: 'openai-models' as const,
	};
	await discoverApiProviderModels(request, executorId);
	await testApiProvider({
		templateId: 'custom', label: 'Synthetic endpoint',
		endpoint: { ...request, defaultModel: 'synthetic-model', models: [], supportsImages: false },
	}, executorId);
	for (const [index, path] of ['models', 'test'].entries()) {
		const [url, options] = fetchMock.mock.calls[index]!;
		expect(url).toBe(`/api/v1/api-providers/${path}?executorId=${executorId}`);
		expect(options?.method).toBe('POST');
	}
});

it('uses explicit executor grants and revisioned global edits with acknowledged shared deletion', async () => {
	const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));
	vi.stubGlobal('fetch', fetchMock);
	await getApiProviderManagement();
	await assignApiProvider('local', 'synthetic_profile');
	await unassignApiProvider('local', 'synthetic_profile');
	await updateApiProvider('synthetic_profile', { revision: 3, label: 'Updated profile' });
	await deleteApiProvider('synthetic_profile');
	await createApiProvider({ templateId: 'custom', label: 'New profile', endpoint: {
		protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'synthetic', models: [], supportsImages: false,
	} }, '22222222-2222-4222-8222-222222222222');
	expect(fetchMock.mock.calls.map(([url, options]) => [url, options?.method ?? 'GET'])).toEqual([
		['/api/v1/api-providers', 'GET'],
		['/api/v1/api-provider-assignments?executorId=local&apiProviderId=synthetic_profile', 'PUT'],
		['/api/v1/api-provider-assignments?executorId=local&apiProviderId=synthetic_profile', 'DELETE'],
		['/api/v1/api-providers?id=synthetic_profile', 'PUT'],
		['/api/v1/api-providers?id=synthetic_profile&acknowledgeSharedImpact=true', 'DELETE'],
		['/api/v1/api-providers?executorId=22222222-2222-4222-8222-222222222222', 'POST'],
	]);
	expect(JSON.parse(String(fetchMock.mock.calls[3]![1]?.body))).toEqual({ revision: 3, label: 'Updated profile' });
});
