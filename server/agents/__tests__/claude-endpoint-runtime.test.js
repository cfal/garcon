import { describe, expect, it } from 'bun:test';
import { buildClaudeEndpointRuntime } from '../claude/endpoint-runtime.ts';

function selection(endpoint = {}) {
  return {
    model: 'acme-claude',
    apiProviderId: 'acme',
    modelEndpointId: 'acme_anthropic',
    modelProtocol: 'anthropic-messages',
    isLocal: false,
    apiProvider: { id: 'acme', label: 'Acme', endpoints: [] },
    endpoint: {
      id: 'acme_anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.acme.test/anthropic',
      apiKey: 'secret',
      defaultModel: 'acme-claude',
      models: [],
      supportsImages: true,
      modelDiscovery: 'none',
      ...endpoint,
    },
  };
}

describe('buildClaudeEndpointRuntime', () => {
  it('builds Anthropic environment overrides for Claude endpoint-backed runs', () => {
    expect(buildClaudeEndpointRuntime(selection())).toEqual({
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://api.acme.test/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        ANTHROPIC_API_KEY: '',
      },
    });
  });

  it('omits auth-token override for blank-key endpoints', () => {
    expect(buildClaudeEndpointRuntime(selection({ apiKey: '' }))).toEqual({
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://api.acme.test/anthropic',
        ANTHROPIC_API_KEY: '',
      },
    });
  });
});
