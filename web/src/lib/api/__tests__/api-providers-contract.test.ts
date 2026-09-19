import { afterEach, expect, it, vi } from 'vitest';
import { discoverApiProviderModels, testApiProvider } from '../api-providers';

afterEach(() => vi.unstubAllGlobals());

it.each(['local', '22222222-2222-4222-8222-222222222222'])('qualifies endpoint test and model discovery by %s', async (nodeId) => {
	const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ success: true }));
	vi.stubGlobal('fetch', fetchMock);
	const request = {
		protocol: 'openai-compatible' as const, baseUrl: 'http://localhost:11434/v1',
		modelDiscovery: 'openai-models' as const,
	};
	await discoverApiProviderModels(request, nodeId);
	await testApiProvider({
		templateId: 'custom', label: 'Synthetic endpoint',
		endpoint: { ...request, defaultModel: 'synthetic-model', models: [], supportsImages: false },
	}, nodeId);
	for (const [index, path] of ['models', 'test'].entries()) {
		const [url, options] = fetchMock.mock.calls[index]!;
		expect(url).toBe(`/api/v1/api-providers/${path}?nodeId=${nodeId}`);
		expect(options?.method).toBe('POST');
	}
});
