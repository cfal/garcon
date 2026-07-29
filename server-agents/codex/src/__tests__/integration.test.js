import { describe, expect, it, mock } from 'bun:test';
import CodexAgentIntegration from '../index.js';

function createHost() {
  return {
    agentId: 'codex',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: '/tmp/garcon-codex-integration-test',
      directory: mock(() => Promise.resolve('/tmp/garcon-codex-integration-test/search')),
      claimLegacyWorkspaceDirectory: mock(() => Promise.resolve({ moved: 0, skipped: 0 })),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
    carryOver: { load: mock(() => Promise.reject(new Error('not used'))) },
  };
}

describe('CodexAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new CodexAgentIntegration(host);

    expect(CodexAgentIntegration.integrationId).toBe('codex');
    expect(CodexAgentIntegration.apiVersion).toBe(2);
    expect(CodexAgentIntegration.transcriptIndex.apiVersion).toBe(1);
    expect(integration.descriptor.id).toBe('codex');
    expect(integration.execution.submitActiveInput).toBeDefined();
    expect(integration.execution.compact).toBeDefined();
    expect(integration.execution.respondToPermission).toBeDefined();
    expect(integration.execution.prepareProjectPathUpdate).toBeUndefined();
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      supportsAtMessage: true,
      supportsWhileRunning: true,
    });
    expect(integration.auth).toBeDefined();
    expect(integration.commands).toBeDefined();
    expect(integration.endpoints).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('preserves version 1 settings and native-session migration envelopes', async () => {
    const integration = new CodexAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'codex',
      schemaVersion: 1,
      values: {},
    });
    await expect(integration.migration.translateLegacyNativeSession({
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'gpt-5.4',
      agentSessionId: 'thread-1',
      legacyNativePath: '/tmp/codex-session.jsonl',
      legacyValues: { modelEndpointId: 'endpoint-1' },
      signal,
    })).resolves.toEqual({
      ownerId: 'codex',
      schemaVersion: 1,
      value: {
        path: '/tmp/codex-session.jsonl',
        agentSessionId: 'thread-1',
        modelEndpointId: 'endpoint-1',
      },
    });
  });
});
