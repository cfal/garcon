import { describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHost } from '@garcon/server-agent-interface';
import { LazyPiRuntime } from '../agents/pi/lazy-runtime.js';
import { PiModelCatalogService } from '../agents/pi/pi-models.js';
import PiAgentIntegration from '../index.js';

function createHost() {
  return {
    agentId: 'pi',
    scope: { executorId: 'local', instanceId: 'test', integrationId: 'pi' },
    migrations: { async getVersion() { return 1; }, async read() { return undefined; }, async commit() {} },
    logger: {
      debug: mock(() => undefined),
      info: mock(() => undefined),
      warn: mock(() => undefined),
      error: mock(() => undefined),
    },
    storage: {
      rootDirectory: '/tmp/garcon-pi-integration-test',
      directory: mock(() => Promise.resolve('/tmp/garcon-pi-integration-test/search')),
      claimLegacyWorkspaceDirectory: mock(() => Promise.resolve({ moved: 0, skipped: 0 })),
    },
    environment: { get: mock(() => undefined) },
    apiProviders: { resolveCredential: mock(() => Promise.resolve(null)) },
  } satisfies AgentHost;
}

describe('PiAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new PiAgentIntegration(host);

    expect(PiAgentIntegration.integrationId).toBe('pi');
    expect(PiAgentIntegration.apiVersion).toBe(5);
    expect(integration.descriptor.id).toBe('pi');
    expect(integration.descriptor.supportsProjectPathUpdate).toBe(true);
    expect(integration.descriptor.requiresNativePathForProjectPathUpdate).toBe(true);
    expect(integration.projectPathUpdates).toBeDefined();
    expect('transcriptSearch' in integration).toBe(false);
    expect(integration.forking).toBeNull();
    expect(integration.auth).toBeDefined();
    expect(integration.singleQuery).toBeDefined();
    expect(integration.steering).toMatchObject({
      captureTarget: expect.any(Function),
      steer: expect.any(Function),
    });
    expect(integration.commands).toBeNull();
    expect(integration.endpoints).toBeNull();
    expect(host.environment.get).not.toHaveBeenCalled();
  });

  it('waits for catalog cleanup even when a session fails to shut down', async () => {
    const cleanup = Promise.withResolvers<void>();
    const failure = new Error('Synthetic session shutdown failure');
    const catalog = spyOn(PiModelCatalogService.prototype, 'stop').mockReturnValue(cleanup.promise);
    const sessions = spyOn(LazyPiRuntime.prototype, 'shutdown').mockRejectedValue(failure);
    try {
      const integration = new PiAgentIntegration(createHost());
      await integration.lifecycle.start();
      let observed: unknown;
      const stopping = integration.lifecycle.stop().catch(error => { observed = error; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(catalog).toHaveBeenCalledTimes(1);
      expect(sessions).toHaveBeenCalledTimes(1);
      expect(observed).toBeUndefined();
      cleanup.resolve();
      await stopping;
      expect(observed).toBe(failure);
    } finally {
      cleanup.resolve();
      catalog.mockRestore();
      sessions.mockRestore();
    }
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
    await expect(integration.nativeSessions.resolveNativeSession({
      chat: {
        chatId: 'chat-1',
        agentId: 'pi',
        agentSessionId: 'session-1',
        projectPath: '/repo',
        model: 'github-copilot/gpt-5.4',
        nativeSession,
        carryOverRevision: '',
        nativeSeedReceipt: null,
        settings: integration.settings.defaults(),
      },
      signal,
    })).resolves.toEqual(nativeSession);
  });

  it('keeps an unresolved native ID for binding without treating it as a transcript on Reload', async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'pi-unresolved-'));
    const integration = new PiAgentIntegration({
      ...createHost(),
      environment: { get: (key) => key === 'PI_CODING_AGENT_SESSION_DIR' ? directory.path : undefined },
    });
    const request = {
      chat: {
        chatId: 'chat-1', agentId: 'pi', agentSessionId: 'session-1', projectPath: directory.path,
        model: 'provider/model', nativeSession: null, carryOverRevision: '', nativeSeedReceipt: null,
        settings: integration.settings.defaults(),
      },
      signal: new AbortController().signal,
    };
    expect(await integration.nativeSessions.resolveNativeSession(request)).toEqual({
      ownerId: 'pi', schemaVersion: 1, value: { path: '!pi:session-1', agentSessionId: 'session-1' },
    });
    expect(await integration.nativeSessions.describeSource(request)).toEqual({ kind: 'provider-reference', value: 'session-1' });
    await expect(Array.fromAsync(integration.nativeHistoryImport.load(request))).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    expect(await Array.fromAsync(integration.legacyHistoryImport.load(request))).toEqual([]);
  });
});
