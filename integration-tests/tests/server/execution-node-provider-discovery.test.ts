import { expect, test } from 'bun:test';
import type { ApiProviderCatalogEntry, ApiProviderModelDiscoveryResponse } from '../../../common/api-providers.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test.each(['remote-controller-dials', 'remote-node-dials'] as const)('endpoint probes use the selected %s node without falling back when disabled', async (executionBackend) => {
  const calls: string[] = [];
  const endpoint = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch(request) {
      calls.push(new URL(request.url).pathname);
      if (request.headers.get('authorization') !== 'Bearer synthetic-discovery-key') return new Response(null, { status: 401 });
      return Response.json({ data: [{ id: 'synthetic-worker-model' }] });
    },
  });
  try {
    await withIntegrationFixture(`provider-discovery-${executionBackend}`, async ({ client }) => {
      const input = {
        templateId: 'custom', label: 'Synthetic discovery endpoint',
        endpoint: {
          protocol: 'openai-compatible', baseUrl: `http://localhost:${endpoint.port}/v1`,
          apiKey: 'synthetic-discovery-key', defaultModel: 'synthetic-worker-model',
          models: [{ value: 'synthetic-worker-model', label: 'Synthetic Model' }],
          modelDiscovery: 'openai-models', supportsImages: false,
        },
      };
      const saved = await client.post<ApiProviderCatalogEntry>(`/api/v1/api-providers?nodeId=${client.nodeId}`, input);
      const discovery = { protocol: 'openai-compatible', baseUrl: input.endpoint.baseUrl,
        apiProviderId: saved.id, endpointId: saved.endpoints[0]!.id, revision: saved.revision };
      for (const [path, body] of [['test', input], ['models', discovery]] as const) {
        const result = await client.post<ApiProviderModelDiscoveryResponse>(`/api/v1/api-providers/${path}?nodeId=${client.nodeId}`, body);
        expect(result).toEqual({ success: true, models: [{ value: 'synthetic-worker-model', label: 'synthetic-worker-model' }] });
      }
      expect(calls).toEqual(['/v1/models', '/v1/models']);
      await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
      for (const [path, body] of [['test', input], ['models', discovery]] as const) {
        await expect(client.post(`/api/v1/api-providers/${path}?nodeId=${client.nodeId}`, body))
          .rejects.toMatchObject({ status: 503, body: { errorCode: 'EXECUTION_NODE_UNAVAILABLE' } });
      }
      expect(calls).toHaveLength(2);
      await expect(client.post('/api/v1/api-providers/models', discovery)).rejects.toMatchObject({ status: 409, body: { errorCode: 'API_PROVIDER_UNAVAILABLE' } });
      await client.put(`/api/v1/api-provider-assignments?nodeId=local&apiProviderId=${saved.id}`, {});
      expect(await client.post<ApiProviderModelDiscoveryResponse>('/api/v1/api-providers/models', discovery)).toMatchObject({ success: true });
      expect(calls).toHaveLength(3);
    }, { executionBackend });
  } finally { endpoint.stop(true); }
}, 30_000);
