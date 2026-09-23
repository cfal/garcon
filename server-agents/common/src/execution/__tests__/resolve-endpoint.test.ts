import { describe, expect, mock, test } from 'bun:test';
import type { AgentHost } from '@garcon/server-agent-interface';
import { resolveAgentEndpoint } from '../resolve-endpoint.js';

describe('resolveAgentEndpoint', () => {
  test.each(['secret', '', null])('distinguishes an explicit key from denied credential resolution (%s)', async (value) => {
    const resolveCredential = mock(async () => value === null ? null : { kind: 'token', value });
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
        revision: 1,
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
    } satisfies AgentHost;
    const result = resolveAgentEndpoint(
      host,
      endpoint,
      new AbortController().signal,
    );
    if (value === null) await expect(result).rejects.toMatchObject({ code: 'API_PROVIDER_UNAVAILABLE' });
    else expect(await result).toEqual({ selection: endpoint, credential: value });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });
});
