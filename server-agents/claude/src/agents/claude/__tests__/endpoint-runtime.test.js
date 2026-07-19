import { describe, expect, it } from 'bun:test';
import { buildClaudeEndpointRuntime } from '../endpoint-runtime.ts';

function selection(endpoint = {}) {
  return {
    selection: {
      apiProviderId: 'acme',
      endpointId: 'acme_anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.acme.test/anthropic',
      model: 'acme-claude',
      isLocal: false,
      credential: null,
      ...endpoint,
    },
    credential: 'secret',
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
    expect(buildClaudeEndpointRuntime({ ...selection(), credential: null })).toEqual({
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://api.acme.test/anthropic',
        ANTHROPIC_API_KEY: '',
      },
    });
  });
});
