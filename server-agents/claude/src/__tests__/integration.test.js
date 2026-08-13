import { describe, expect, it, mock } from 'bun:test';
import ClaudeAgentIntegration from '../index.js';

function createHost() {
  return {
    agentId: 'claude',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: '/tmp/garcon-claude-integration-test',
      directory: mock(() => Promise.resolve('/tmp/garcon-claude-integration-test/search')),
      claimLegacyWorkspaceDirectory: mock(() => Promise.resolve({ moved: 0, skipped: 0 })),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
  };
}

describe('ClaudeAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new ClaudeAgentIntegration(host);

    expect(ClaudeAgentIntegration.integrationId).toBe('claude');
    expect(ClaudeAgentIntegration.apiVersion).toBe(5);
    expect(integration.descriptor.id).toBe('claude');
    expect(integration.descriptor.requiresNativePathForProjectPathUpdate).toBe(false);
    expect(integration.projectPathUpdates).toBeDefined();
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      fork: expect.any(Function),
      discard: expect.any(Function),
    });
    expect(integration.steering).toEqual({
      captureTarget: expect.any(Function),
      steer: expect.any(Function),
    });
    expect(integration.auth).toBeDefined();
    expect(integration.commands).toBeDefined();
    expect(integration.endpoints).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(integration.settings.describe()).toEqual([
      expect.objectContaining({
        key: 'claudeThinkingMode',
        labelKey: 'thinking',
        options: [
          expect.objectContaining({
            value: 'auto',
            labelKey: 'automatic',
            descriptionKey: 'thinkingAutomatic',
          }),
          expect.objectContaining({
            value: 'on',
            labelKey: 'enabled',
            descriptionKey: 'thinkingEnabled',
          }),
          expect.objectContaining({
            value: 'off',
            labelKey: 'disabled',
            descriptionKey: 'thinkingDisabled',
          }),
        ],
      }),
    ]);
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('preserves version 1 settings and native-session migration envelopes', async () => {
    const integration = new ClaudeAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'claude',
      schemaVersion: 1,
      values: { claudeThinkingMode: 'auto' },
    });
    await expect(integration.migration.translateLegacyNativeSession({
      chatId: 'chat-1',
      projectPath: '/repo',
      model: 'sonnet',
      agentSessionId: 'session-1',
      legacyNativePath: '/tmp/claude-session.jsonl',
      legacyValues: { modelEndpointId: 'endpoint-1' },
      signal,
    })).resolves.toEqual({
      ownerId: 'claude',
      schemaVersion: 1,
      value: {
        path: '/tmp/claude-session.jsonl',
        agentSessionId: 'session-1',
        modelEndpointId: 'endpoint-1',
      },
    });
  });
});
