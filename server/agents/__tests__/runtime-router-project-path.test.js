import { resolveFileMentionsInCommand } from "../../chats/file-mentions.ts";
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
    preparation: {
      kind: 'project-path-preparation', nodeId: 'node-1', instanceId: 'instance-1',
      integrationId: 'claude', id: 'preparation-1',
    },
  };
  const commit = mock(async () => undefined);
  const rollback = mock(async () => undefined);
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
    projectPathUpdates: { prepare: prepareProjectPathUpdate, commit, rollback },
  };
  const router = new AgentRuntimeRouter({
    resolveFileMentions: resolveFileMentionsInCommand,
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
    createCarriedContext: async () => ({ kind: 'no-history' }),
    getCarryOverMessageCount: async () => 0,
    ledger: transcript.ledger,
    hasPendingOwnershipTransfer: () => false,
    adoption: transcript.adoption,
  });

  return { entry, preparation, prepareProjectPathUpdate, commit, rollback, router };
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

    expect(result.nativeSession).toEqual(resolvedNativeSession);
    await result.commit();
    await result.rollback();
    expect(fixture.commit).toHaveBeenCalledWith(fixture.preparation.preparation);
    expect(fixture.rollback).toHaveBeenCalledWith(fixture.preparation.preparation);
    expect(fixture.prepareProjectPathUpdate).toHaveBeenCalledWith({
      chat: expect.objectContaining({
        chatId: 'chat-1',
        agentSessionId: 'session-1',
        projectPath: '/old',
        nativeSession: resolvedNativeSession,
      }),
      nextProjectPath: '/next',
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
