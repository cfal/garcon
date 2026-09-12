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
  it('normalizes the custom endpoint subagent model without changing the selection', () => {
    const endpoint = selection({ model: 'acme-claude[922k]' });
    expect(buildClaudeEndpointRuntime(endpoint).envOverrides.CLAUDE_CODE_SUBAGENT_MODEL)
      .toBe('acme-claude[1m]');
    expect(endpoint.selection.model).toBe('acme-claude[922k]');
  });

  it('builds Anthropic environment overrides for Claude endpoint-backed runs', () => {
    expect(buildClaudeEndpointRuntime(selection())).toEqual({
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://api.acme.test/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_SUBAGENT_MODEL: 'acme-claude',
      },
    });
  });

  it('omits auth-token override for blank-key endpoints', () => {
    expect(buildClaudeEndpointRuntime({ ...selection(), credential: null })).toEqual({
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://api.acme.test/anthropic',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_SUBAGENT_MODEL: 'acme-claude',
      },
    });
  });
});
