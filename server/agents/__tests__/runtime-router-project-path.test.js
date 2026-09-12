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
  /** @satisfies {import('../../execution-nodes/provider-project-path.js').ProviderProjectPathUpdateService} */
  const service = { prepare: prepareProjectPathUpdate };
  const projectPathUpdatesFor = mock(() => overrides.unsupported ? null : service);
  const router = new AgentRuntimeRouter({
    fileMentions: { resolve: async (command) => command },
    registry: {
      getChat: mock(() => entry),
    },
    instances: { projectPathUpdatesFor },
    providerIds: ['test'],
    endpointResolver: {},
    events: {},
    projection: {},
    getCarryOverRevision: () => 'carry-1',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
  });

  return { entry, preparation, prepareProjectPathUpdate, projectPathUpdatesFor, router };
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
        settings: null,
      }),
      nextProjectPath: '/next',
    }, expect.any(AbortSignal));
    expect(fixture.projectPathUpdatesFor).toHaveBeenCalledWith(fixture.entry);
    expect(fixture.entry.nativeSession).toBe(storedNativeSession);
  });

  it('preserves an absent project-path capability', async () => {
    const fixture = makeRouter({ unsupported: true });
    expect(await fixture.router.prepareProjectPathUpdate('claude', {
      chatId: 'chat-1', agentSessionId: 'session-1', previousProjectPath: '/old',
      nextProjectPath: '/next', nativeSession: resolvedNativeSession,
    })).toBeUndefined();
    expect(fixture.prepareProjectPathUpdate).not.toHaveBeenCalled();
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
