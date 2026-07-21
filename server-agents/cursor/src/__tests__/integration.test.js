import { describe, expect, it, mock } from 'bun:test';
import CursorAgentIntegration from '../index.js';

function createHost() {
  return {
    agentId: 'cursor',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: '/tmp/garcon-cursor-integration-test',
      directory: mock(() => Promise.resolve('/tmp/garcon-cursor-integration-test/search')),
      claimLegacyWorkspaceDirectory: mock(() => Promise.resolve({ moved: 0, skipped: 0 })),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
    carryOver: { load: mock(() => Promise.reject(new Error('not used'))) },
  };
}

describe('CursorAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new CursorAgentIntegration(host);

    expect(CursorAgentIntegration.integrationId).toBe('cursor');
    expect(CursorAgentIntegration.apiVersion).toBe(2);
    expect(CursorAgentIntegration.transcriptIndex.apiVersion).toBe(1);
    expect(integration.descriptor.id).toBe('cursor');
    expect(integration.descriptor.supportsProjectPathUpdate).toBe(true);
    expect(integration.execution.prepareProjectPathUpdate).toBeDefined();
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
    const integration = new CursorAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'cursor',
      schemaVersion: 1,
      values: {},
    });
    await expect(integration.transcript.resolveNativeSession({
      chat: {
        chatId: 'chat-1',
        agentId: 'cursor',
        agentSessionId: 'session-1',
        projectPath: '/repo',
        model: '',
        nativeSession: null,
        carryOverRevision: '',
        settings: integration.settings.defaults(),
      },
      signal,
    })).resolves.toEqual({
      ownerId: 'cursor',
      schemaVersion: 1,
      value: {
        path: '!cursor-acp:session-1',
        agentSessionId: 'session-1',
      },
    });
  });
});
