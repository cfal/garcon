import { describe, expect, mock, test } from 'bun:test';
import { AgentCallError, type AgentApiProviderReader, type AgentHost } from '@garcon/server-agent-interface';
import { resolveAgentEndpoint } from '../resolve-endpoint.js';

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

function hostResolving(resolveCredential: AgentApiProviderReader['resolveCredential']) {
  return {
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
}

describe('resolveAgentEndpoint', () => {
  test.each(['secret', '', null])('distinguishes an explicit key from denied credential resolution (%s)', async (value) => {
    const resolveCredential = mock(async () => value === null ? null : { kind: 'token' as const, value });
    const result = resolveAgentEndpoint(
      hostResolving(resolveCredential),
      endpoint,
      new AbortController().signal,
    );
    if (value === null) await expect(result).rejects.toMatchObject({ code: 'API_PROVIDER_UNAVAILABLE' });
    else expect(await result).toEqual({ selection: endpoint, credential: value });
    expect(resolveCredential).toHaveBeenCalledTimes(1);
  });

  test('fails definitely, and retryably, when the credential read has an unknown outcome', async () => {
    const host = hostResolving(async () => {
      throw new AgentCallError('unknown', 'Synthetic credential read outcome is unknown');
    });

    await expect(resolveAgentEndpoint(host, endpoint, new AbortController().signal)).rejects.toMatchObject({
      outcome: 'rejected', code: 'UNAVAILABLE', message: 'Provider credential could not be read from the controller. Try again.',
    });
  });

  test('fails the same way when the credential read never reached the controller', async () => {
    // A worker without a controller session refuses the read before it returns a promise.
    const host = hostResolving(() => {
      throw new AgentCallError('not-dispatched', 'Executor controller is disconnected');
    });

    await expect(resolveAgentEndpoint(host, endpoint, new AbortController().signal)).rejects.toMatchObject({
      outcome: 'rejected', code: 'UNAVAILABLE', message: 'Provider credential could not be read from the controller. Try again.',
    });
  });

  test('reports cancellation rather than a credential read that the cancellation left unknown', async () => {
    const cancel = new AbortController();
    const host = hostResolving(async () => {
      cancel.abort(new Error('Synthetic cancellation'));
      throw new AgentCallError('unknown', 'The request was cancelled after it was sent to the executor.');
    });

    await expect(resolveAgentEndpoint(host, endpoint, cancel.signal)).rejects.toThrow('Synthetic cancellation');
  });
});
