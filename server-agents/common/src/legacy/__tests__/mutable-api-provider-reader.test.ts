import { describe, expect, it } from 'bun:test';
import { MutableApiProviderReader } from '../mutable-api-provider-reader.js';

describe('MutableApiProviderReader', () => {
  it('preserves package-owned endpoint capabilities for direct routing', () => {
    const reader = new MutableApiProviderReader({ chatCompletions: true, responses: false });

    reader.register({
      apiProviderId: 'provider-1',
      endpointId: 'endpoint-1',
      protocol: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      model: 'model-1',
      isLocal: false,
      credential: null,
    }, 'secret');

    expect(reader.getEndpoint('endpoint-1')?.endpoint).toMatchObject({
      apiKey: 'secret',
      capabilities: { chatCompletions: true, responses: false },
    });
  });
});
