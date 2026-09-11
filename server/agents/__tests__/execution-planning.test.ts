import { expect, mock, test } from 'bun:test';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import type { StoredApiProvider } from '../../api-providers/store.js';
import { toAdmittedEndpoint, toAgentEndpointSelection } from '../execution-planning.js';

function fixture() {
  const provider: StoredApiProvider = {
    id: 'synthetic-provider', label: 'Synthetic provider',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    endpoints: [{
      id: 'synthetic-endpoint', protocol: 'openai-compatible', baseUrl: 'https://original.invalid/v1',
      apiKey: 'synthetic-original-key', defaultModel: 'synthetic-model',
      models: [{ value: 'synthetic-model', label: 'Synthetic model' }],
      supportsImages: false, modelDiscovery: 'none', headers: { 'x-synthetic': 'original' },
      capabilities: { responses: true },
    }],
  };
  const read = mock(() => [provider]);
  const resolver = new ApiProviderEndpointResolver(read, () => ['openai-compatible']);
  const selection = resolver.resolveSelection({
    agentId: 'synthetic', model: 'synthetic-model', apiProviderId: provider.id, modelEndpointId: provider.endpoints[0]!.id,
  });
  read.mockClear();
  return { provider, read, resolver, selection };
}

test('captures owned endpoint metadata and its credential in one store read', () => {
  const f = fixture();
  const original = toAdmittedEndpoint(f.resolver, f.selection);
  expect(f.read).toHaveBeenCalledTimes(1);
  Object.assign(f.provider.endpoints[0]!, {
    baseUrl: 'https://updated.invalid/v1', apiKey: 'synthetic-updated-key',
  });
  f.provider.endpoints[0]!.headers!['x-synthetic'] = 'updated';
  f.provider.endpoints[0]!.capabilities!.responses = false;
  expect(original).toMatchObject({
    selection: { baseUrl: 'https://original.invalid/v1', headers: { 'x-synthetic': 'original' }, capabilities: { responses: true } },
    credential: 'synthetic-original-key',
  });
  expect(toAdmittedEndpoint(f.resolver, f.selection)).toMatchObject({
    selection: { baseUrl: 'https://updated.invalid/v1', headers: { 'x-synthetic': 'updated' }, capabilities: { responses: false } },
    credential: 'synthetic-updated-key',
  });
  expect(f.read).toHaveBeenCalledTimes(2);
});

test('keeps session configuration metadata secret-free and preserves native authentication', () => {
  const f = fixture();
  const metadata = toAgentEndpointSelection(f.resolver, f.selection);
  expect(metadata).toMatchObject({ endpointId: 'synthetic-endpoint', baseUrl: 'https://original.invalid/v1' });
  expect(metadata).not.toHaveProperty('credential');
  expect(JSON.stringify(metadata)).not.toContain('synthetic-original-key');
  f.provider.endpoints[0]!.apiKey = '';
  expect(toAdmittedEndpoint(f.resolver, f.selection)?.credential).toBeNull();
  f.read.mockClear();
  expect(toAdmittedEndpoint(f.resolver, { ...f.selection, apiProviderId: null, endpointId: null, protocol: null })).toBeNull();
  expect(f.read).not.toHaveBeenCalled();
});
