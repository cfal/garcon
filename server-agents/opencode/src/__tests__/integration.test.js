import { describe, expect, it, mock } from 'bun:test';
import OpenCodeAgentIntegration, { createOpenCodeNativeEvidence } from '../index.js';
import { OpenCodeRuntime } from '../agents/opencode/opencode.js';

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
  };
}

describe('OpenCodeAgentIntegration', () => {
  it('composes the provider facets without reading environment during construction', () => {
    const host = createHost();
    const integration = new OpenCodeAgentIntegration(host);

    expect(OpenCodeAgentIntegration.integrationId).toBe('opencode');
    expect(OpenCodeAgentIntegration.apiVersion).toBe(5);
    expect(integration.descriptor.id).toBe('opencode');
    expect(integration.execution).toBeDefined();
    expect(integration.nativeHistoryImport).toBeDefined();
    expect(integration.nativeSessions).toBeDefined();
    expect(integration.descriptor.supportsProjectPathUpdate).toBe(true);
    expect(integration.projectPathUpdates).toMatchObject({ prepare: expect.any(Function) });
    expect(integration.transcriptSearch).toBeUndefined();
    expect(integration.forking).toMatchObject({
      fork: expect.any(Function),
      discard: expect.any(Function),
    });
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

  it('preserves version 1 settings and native-session envelopes', async () => {
    const integration = new OpenCodeAgentIntegration(createHost());
    const signal = new AbortController().signal;

    expect(integration.settings.defaults()).toEqual({
      ownerId: 'opencode',
      schemaVersion: 1,
      values: {},
    });
    await expect(integration.nativeSessions.resolveNativeSession({
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

  it('cancels native-history lease acquisition without cancelling shared startup', async () => {
    const startupStarted = deferred();
    const pendingInstance = deferred();
    const get = mock(() => Promise.resolve({ data: { id: 'session-1' } }));
    const messages = mock(() => Promise.resolve({ data: [] }));
    let startupSignal;
    const runtime = new OpenCodeRuntime({
      createInstance: mock(({ signal }) => {
        startupSignal = signal;
        startupStarted.resolve();
        return pendingInstance.promise;
      }),
    });
    const nativeEvidence = createOpenCodeNativeEvidence(
      runtime,
      { encode: mock(() => null), decode: mock(() => ({ agentSessionId: null, path: null })) },
      (chat) => chat.agentSessionId ?? null,
    );
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const outcome = nativeEvidence.load({
      chat: {
        chatId: 'target-chat',
        agentId: 'opencode',
        agentSessionId: 'session-1',
        projectPath: '/repo',
        model: '',
        nativeSession: null,
        carryOverRevision: '',
        settings: { ownerId: 'opencode', schemaVersion: 1, values: {} },
      },
      signal: controller.signal,
    });

    await startupStarted.promise;
    controller.abort(reason);

    await expect(Promise.race([
      outcome.then(() => 'fulfilled', (error) => error),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ])).resolves.toBe(reason);
    expect(startupSignal.aborted).toBe(false);

    pendingInstance.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        session: { get, messages },
      },
      server: { close: mock(() => {}) },
    });
    await runtime.shutdown();
    expect(get).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
  });
});
