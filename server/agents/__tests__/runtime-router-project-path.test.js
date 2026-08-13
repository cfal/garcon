import { describe, expect, it, mock } from 'bun:test';

import { AgentRuntimeRouter } from '../runtime-router.ts';
import { createRuntimeTranscriptFixture } from './runtime-router-test-fixture.js';

const storedNativeSession = {
  ownerId: 'claude',
  schemaVersion: 1,
  value: { path: '/old/session.jsonl' },
};
const resolvedNativeSession = {
  ownerId: 'claude',
  schemaVersion: 1,
  value: { path: '/recovered/session.jsonl' },
};

function makeRouter(overrides = {}) {
  const transcript = createRuntimeTranscriptFixture();
  const preparation = {
    nativeSession: resolvedNativeSession,
    commit: mock(() => Promise.resolve()),
    rollback: mock(() => Promise.resolve()),
  };
  const prepareProjectPathUpdate = mock(() => Promise.resolve(preparation));
  const entry = {
    agentId: 'claude',
    agentOwnershipEpoch: 'epoch-1',
    agentSessionId: 'session-1',
    nativeSession: storedNativeSession,
    projectPath: '/old',
    model: 'sonnet',
    agentSettingsById: {},
    ...overrides.entry,
  };
  const integration = {
    descriptor: { id: 'claude' },
    settings: {
      defaults: mock(() => ({
        ownerId: 'claude',
        schemaVersion: 1,
        values: {},
      })),
      parse: mock((settings) => settings),
    },
    projectPathUpdates: { prepare: prepareProjectPathUpdate },
  };
  const router = new AgentRuntimeRouter({
    registry: {
      getChat: mock(() => entry),
    },
    directory: {
      require: mock(() => integration),
    },
    endpointResolver: {},
    events: {},
    projection: {},
    getCarryOverRevision: () => 'carry-1',
createCarriedContext: async () => null,
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    adoption: transcript.adoption,
  });

  return { entry, preparation, prepareProjectPathUpdate, router };
}

describe('AgentRuntimeRouter project-path preparation', () => {
  it('forwards the resolved native session and preserves the preparation result', async () => {
    const fixture = makeRouter();

    const result = await fixture.router.prepareProjectPathUpdate('claude', {
      chatId: 'chat-1',
      agentSessionId: 'session-1',
      previousProjectPath: '/old',
      nextProjectPath: '/next',
      nativeSession: resolvedNativeSession,
    });

    expect(result).toBe(fixture.preparation);
    expect(fixture.prepareProjectPathUpdate).toHaveBeenCalledWith({
      chat: expect.objectContaining({
        chatId: 'chat-1',
        agentSessionId: 'session-1',
        projectPath: '/old',
        nativeSession: resolvedNativeSession,
      }),
      nextProjectPath: '/next',
      signal: expect.any(AbortSignal),
    });
    expect(fixture.entry.nativeSession).toBe(storedNativeSession);
  });

  it('rejects a stale request before calling the provider', async () => {
    const fixture = makeRouter({
      entry: { projectPath: '/changed' },
    });

    await expect(fixture.router.prepareProjectPathUpdate('claude', {
      chatId: 'chat-1',
      agentSessionId: 'session-1',
      previousProjectPath: '/old',
      nextProjectPath: '/next',
      nativeSession: resolvedNativeSession,
    })).rejects.toThrow('Session changed while preparing project path');

    expect(fixture.prepareProjectPathUpdate).not.toHaveBeenCalled();
  });
});
