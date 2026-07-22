import { describe, expect, it, mock } from 'bun:test';
import OpenCodeAgentIntegration from '../index.js';

function createHost() {
  return {
    agentId: 'opencode',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: '/tmp/opencode-test',
      directory: mock(() => Promise.resolve('/tmp/opencode-test/search')),
      claimLegacyWorkspaceDirectory: mock(() => Promise.resolve({ moved: 0, skipped: 0 })),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
    carryOver: { load: mock(() => Promise.reject(new Error('not used'))) },
  };
}

describe('OpenCodeAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new OpenCodeAgentIntegration(host);

    expect(OpenCodeAgentIntegration.integrationId).toBe('opencode');
    expect(OpenCodeAgentIntegration.apiVersion).toBe(2);
    expect(OpenCodeAgentIntegration.transcriptIndex.apiVersion).toBe(1);
    expect(integration.descriptor.id).toBe('opencode');
    expect(integration.execution).toBeDefined();
    expect(integration.transcript).toBeDefined();
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      supportsAtMessage: false,
      supportsAtMessageWhileRunning: false,
    });
    expect(integration.auth).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(integration.commands).toBeNull();
    expect(integration.endpoints).toBeNull();
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('preserves version 1 settings and native-session envelopes', async () => {
    const integration = new OpenCodeAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'opencode',
      schemaVersion: 1,
      values: {},
    });
    await expect(integration.transcript.resolveNativeSession({
      chat: {
        chatId: 'chat-1',
        agentId: 'opencode',
        agentSessionId: 'session-1',
        projectPath: '/repo',
        model: '',
        nativeSession: null,
        carryOverRevision: '',
        settings: integration.settings.defaults(),
      },
      signal,
    })).resolves.toEqual({
      ownerId: 'opencode',
      schemaVersion: 1,
      value: {
        path: '!opencode:session-1',
        agentSessionId: 'session-1',
      },
    });
  });
});
