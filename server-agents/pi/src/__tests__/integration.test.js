import { describe, expect, it, mock } from 'bun:test';
import PiAgentIntegration from '../index.js';

function createHost() {
  return {
    agentId: 'pi',
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: '/tmp/garcon-pi-integration-test',
      directory: mock(() => Promise.resolve('/tmp/garcon-pi-integration-test/search')),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
    carryOver: { load: mock(() => Promise.reject(new Error('not used'))) },
  };
}

describe('PiAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new PiAgentIntegration(host);

    expect(PiAgentIntegration.integrationId).toBe('pi');
    expect(PiAgentIntegration.apiVersion).toBe(2);
    expect(PiAgentIntegration.transcriptIndex.apiVersion).toBe(1);
    expect(integration.descriptor.id).toBe('pi');
    expect(integration.descriptor.supportsProjectPathUpdate).toBe(true);
    expect(integration.descriptor.requiresNativePathForProjectPathUpdate).toBe(true);
    expect(integration.execution.prepareProjectPathUpdate).toBeDefined();
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      supportsAtMessage: false,
      supportsWhileRunning: false,
    });
    expect(integration.auth).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(integration.commands).toBeNull();
    expect(integration.endpoints).toBeNull();
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('preserves version 1 settings and stable real native-session envelopes', async () => {
    const integration = new PiAgentIntegration(createHost());
    const signal = new AbortController().signal;
    const nativeSession = {
      ownerId: 'pi',
      schemaVersion: 1,
      value: {
        path: '/tmp/pi-session.jsonl',
        agentSessionId: 'session-1',
      },
    };

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'pi',
      schemaVersion: 1,
      values: {},
    });
    await expect(integration.transcript.resolveNativeSession({
      chat: {
        chatId: 'chat-1',
        agentId: 'pi',
        agentSessionId: 'session-1',
        projectPath: '/repo',
        model: 'github-copilot/gpt-5.4',
        nativeSession,
        carryOverRevision: '',
        settings: integration.settings.defaults(),
      },
      signal,
    })).resolves.toEqual(nativeSession);
  });
});
