import { describe, expect, mock, test } from 'bun:test';
import type { AgentHost } from '@garcon/server-agent-interface';
import { resolveAgentEndpoint } from '../resolve-endpoint.js';

describe('resolveAgentEndpoint', () => {
  test('resolves credentials through the host reader', async () => {
    const resolveCredential = mock(async () => ({ kind: 'token', value: 'secret' }));
    const endpoint = {
      apiProviderId: 'provider',
      endpointId: 'endpoint',
      providerLabel: 'Provider',
      protocol: 'openai-compatible' as const,
      baseUrl: 'https://example.test',
      model: 'model',
      isLocal: false,
      capabilities: { chatCompletions: false, responses: true },
      headers: {},
      credential: {
        kind: 'api-provider-endpoint' as const,
        apiProviderId: 'provider',
        endpointId: 'endpoint',
      },
    };
    const host = {
      agentId: 'test',
      logger: {
        debug() {}, info() {}, warn() {}, error() {},
      },
      storage: {
        rootDirectory: '/tmp',
        directory: async () => '/tmp',
        claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
      },
      environment: { get: () => undefined },
      apiProviders: { resolveCredential },
      carryOver: {
        load: async () => ({ revision: 'empty', messages: [] }),
      },
    } satisfies AgentHost;
    const result = await resolveAgentEndpoint(
      host,
      endpoint,
      new AbortController().signal,
    );
    expect(result).toEqual({ selection: endpoint, credential: 'secret' });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });
});
