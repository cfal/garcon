import { describe, expect, it, mock } from 'bun:test';

import { createNativeSeedReceipt } from '../../../common/transcript-seed.js';
import { forkChatFileCopy } from '../fork-chat.js';

const HEAD_ID = '11111111-1111-4111-8111-111111111111';
const envelope = (ownerId, values = {}) => ({ ownerId, schemaVersion: 1, values });

function sourceSession(overrides = {}) {
  return {
    id: 'source-chat',
    agentId: 'test',
    agentSessionId: 'source-native',
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'source-native' } },
    agentOwnershipEpoch: 'source-epoch',
    agentSettingsById: {
      test: envelope('test', { mode: 'careful' }),
      other: envelope('other', { retained: true }),
    },
    model: 'model-a',
    apiProviderId: 'provider-a',
    modelEndpointId: 'endpoint-a',
    modelProtocol: 'openai-compatible',
    projectPath: '/repo',
    tags: ['review'],
    permissionMode: 'acceptEdits',
    thinkingMode: 'high',
    carryOverSegments: [],
    nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const sessions = new Map([['source-chat', overrides.source ?? sourceSession()]]);
  const registry = {
    addChat: mock((entry) => {
      if (sessions.has(entry.id)) return false;
      sessions.set(entry.id, entry);
      return true;
    }),
    getChat: mock((chatId) => sessions.get(chatId) ?? null),
    updateChat: mock((chatId, patch) => {
      const current = sessions.get(chatId);
      if (!current) return null;
      const updated = { ...current, ...patch };
      sessions.set(chatId, updated);
      return updated;
    }),
    flush: mock(async () => undefined),
  };
  const settings = {
    getChatName: mock(() => 'Source title'),
    ensureInNormal: mock(async () => undefined),
    setSessionName: mock(async () => undefined),
    removeFromAllOrderLists: mock(async () => undefined),
    removeSessionName: mock(async () => undefined),
    ...overrides.settings,
  };
  const metadata = {
    getChatMetadata: mock(() => ({ firstMessage: 'First prompt' })),
    addNewChatMetadata: mock(() => undefined),
  };
  const carryOver = {
    assertAvailable: mock(async () => undefined),
    logicalMessageCount: mock(() => 0),
    resolveCutoff: mock((refs) => refs),
    ...overrides.carryOver,
  };
  const ownership = overrides.ownership ?? {
    delete: mock(async (chatId) => {
      sessions.delete(chatId);
    }),
  };
  const getViewCursor = overrides.getViewCursor ?? mock(() => null);
  const forkAgentSession = overrides.forkAgentSession ?? mock(async () => ({
    kind: 'materialized',
    session: {
      agentSessionId: 'target-native',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'target-native' } },
      nativeSeedReceipt: null,
    },
  }));
  const discardForkedAgentSession = overrides.discardForkedAgentSession
    ?? mock(async () => undefined);
  const nativeUserIdentities = {
    copyChat: mock(() => undefined),
    clearChat: mock(() => undefined),
  };
  return {
    registry,
    settings,
    metadata,
    carryOver,
    ownership,
    getViewCursor,
    forkAgentSession,
    discardForkedAgentSession,
    nativeUserIdentities,
    sessions,
  };
}

describe('forkChatFileCopy', () => {
  it('shares whole archived segments without creating pages or a provider session', async () => {
    const refs = [segmentRef()];
    const deps = makeDeps({
      source: sourceSession({
        agentSessionId: null,
        nativeSession: null,
        carryOverSegments: refs,
      }),
      carryOver: { logicalMessageCount: mock(() => 3) },
    });

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    });

    expect(result.agentSessionId).toBeNull();
    expect(deps.forkAgentSession).not.toHaveBeenCalled();
    expect(deps.nativeUserIdentities.copyChat).not.toHaveBeenCalled();
    expect(deps.sessions.get('target-chat')).toMatchObject({
      agentSessionId: null,
      nativeSession: null,
      carryOverSegments: refs,
      agentOwnershipEpoch: expect.any(String),
    });
  });

  it('slices references for a point inside archived history without writing a prefix artifact', async () => {
    const quarantine = { artifactId: 'legacy', errorCode: 'INVALID_CARRYOVER_ENTRY' };
    const refs = [segmentRef({ storedMessageCount: 4, visibleMessageCount: 4 })];
    const selected = [segmentRef({
      storedMessageCount: 4,
      visibleMessageCount: 2,
      trailingHandoff: null,
    })];
    const deps = makeDeps({
      source: sourceSession({ carryOverSegments: refs, carryOverMigrationQuarantine: quarantine }),
      carryOver: {
        logicalMessageCount: mock(() => 4),
        resolveCutoff: mock(() => selected),
      },
    });

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 2,
      ...deps,
    });

    expect(result.agentSessionId).toBeNull();
    expect(deps.forkAgentSession).not.toHaveBeenCalled();
    expect(deps.sessions.get('target-chat')).toMatchObject({
      carryOverSegments: selected,
      carryOverMigrationQuarantine: quarantine,
    });
  });

  it('keeps a lazy whole child when an unmaterialized fork loses no visible native messages', async () => {
    const deps = makeDeps({
      source: sourceSession({ carryOverSegments: [segmentRef()] }),
      carryOver: { logicalMessageCount: mock(() => 2) },
      getViewCursor: mock(() => ({ lastSeq: 2 })),
      forkAgentSession: mock(async () => ({ kind: 'unmaterialized' })),
    });

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    });

    expect(result.agentSessionId).toBeNull();
    expect(deps.sessions.get('target-chat')).toMatchObject({
      agentSessionId: null,
      nativeSession: null,
      carryOverSegments: [segmentRef()],
    });
  });

  it('refuses an unmaterialized provider fork when the source view has native messages', async () => {
    const deps = makeDeps({
      getViewCursor: mock(() => ({ lastSeq: 1 })),
      forkAgentSession: mock(async () => ({ kind: 'unmaterialized' })),
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_NOT_YET_PERSISTED',
      status: 409,
      retryable: true,
    });

    expect(deps.registry.addChat).not.toHaveBeenCalled();
  });

  it('rejects a point beyond archived history when no native session exists', async () => {
    const deps = makeDeps({
      source: sourceSession({
        agentSessionId: null,
        nativeSession: null,
        carryOverSegments: [segmentRef()],
      }),
      carryOver: { logicalMessageCount: mock(() => 2) },
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 3,
      ...deps,
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE', status: 422 });

    expect(deps.registry.addChat).not.toHaveBeenCalled();
  });

  it('translates a combined point into a native provider fork and preserves settings', async () => {
    const deps = makeDeps({
      source: sourceSession({ carryOverSegments: [segmentRef()] }),
      carryOver: { logicalMessageCount: mock(() => 2) },
    });

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 3,
      ...deps,
    });

    expect(result).toMatchObject({
      sourceChatId: 'source-chat',
      chatId: 'target-chat',
      agentId: 'test',
      agentSessionId: 'target-native',
    });
    expect(deps.forkAgentSession).toHaveBeenCalledWith({
      sourceSession: expect.objectContaining({ agentSessionId: 'source-native' }),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 3,
    });
    expect(deps.nativeUserIdentities.copyChat).toHaveBeenCalledWith(
      'source-chat',
      'target-chat',
    );
    expect(deps.sessions.get('target-chat')).toMatchObject({
      agentId: 'test',
      agentSessionId: 'target-native',
      carryOverSegments: [segmentRef()],
      model: 'model-a',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentSettingsById: {
        test: envelope('test', { mode: 'careful' }),
        other: envelope('other', { retained: true }),
      },
    });
  });

  it('retargets and persists an exact provider seed receipt', async () => {
    const sourceReceipt = createNativeSeedReceipt({
      agentSessionId: 'source-native',
      placement: 'user-prefix',
      prefix: 'seed',
    });
    const targetReceipt = { ...sourceReceipt, agentSessionId: 'target-native' };
    const deps = makeDeps({
      source: sourceSession({ carryOverSegments: [segmentRef()], nativeSeedReceipt: sourceReceipt }),
      carryOver: { logicalMessageCount: mock(() => 2) },
      forkAgentSession: mock(async () => ({
        kind: 'materialized',
        session: {
          agentSessionId: 'target-native',
          nativeSession: { ownerId: 'test', schemaVersion: 1, value: {} },
          nativeSeedReceipt: targetReceipt,
        },
      })),
    });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    });

    expect(deps.sessions.get('target-chat').nativeSeedReceipt).toEqual(targetReceipt);
  });

  it('rejects and discards a fork with an invalid provider seed receipt', async () => {
    const sourceReceipt = createNativeSeedReceipt({
      agentSessionId: 'source-native',
      placement: 'user-prefix',
      prefix: 'seed',
    });
    const deps = makeDeps({
      source: sourceSession({ carryOverSegments: [segmentRef()], nativeSeedReceipt: sourceReceipt }),
      forkAgentSession: mock(async () => ({
        kind: 'materialized',
        session: {
          agentSessionId: 'target-native',
          nativeSession: { ownerId: 'test', schemaVersion: 1, value: {} },
          nativeSeedReceipt: { ...sourceReceipt, agentSessionId: 'wrong-session' },
        },
      })),
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toThrow('invalid carried-context receipt');

    expect(deps.discardForkedAgentSession).toHaveBeenCalledOnce();
    expect(deps.registry.addChat).not.toHaveBeenCalled();
  });

  it('discards a native fork when the registry target collides', async () => {
    const deps = makeDeps();
    deps.sessions.set('target-chat', sourceSession({ id: 'target-chat' }));

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toThrow('Chat ID collision');

    expect(deps.discardForkedAgentSession).toHaveBeenCalledOnce();
  });

  it('rolls back a point-fork target when target setup fails', async () => {
    const failure = new Error('settings failed');
    const selected = [segmentRef({ visibleMessageCount: 2, trailingHandoff: null })];
    const deps = makeDeps({
      source: sourceSession({ carryOverSegments: [segmentRef()] }),
      carryOver: {
        logicalMessageCount: mock(() => 4),
        resolveCutoff: mock(() => selected),
      },
      settings: { setSessionName: mock(async () => { throw failure; }) },
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 2,
      ...deps,
    })).rejects.toBe(failure);

    expect(deps.ownership.delete).toHaveBeenCalledWith('target-chat');
  });

  it('uses and advances the persisted source fork ordinal', async () => {
    const deps = makeDeps({ source: sourceSession({ nextForkOrdinal: 4 }) });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    });

    expect(deps.settings.setSessionName).toHaveBeenCalledWith('target-chat', 'Source title (4)');
    expect(deps.sessions.get('source-chat').nextForkOrdinal).toBe(5);
    expect(deps.sessions.get('target-chat').nextForkOrdinal).toBe(1);
  });

  it('rolls back every durable target side effect idempotently', async () => {
    const deps = makeDeps({ source: sourceSession({ nextForkOrdinal: 3 }) });
    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    });

    await result.rollback();
    await result.rollback();

    expect(deps.sessions.get('target-chat')).toBeUndefined();
    expect(deps.sessions.get('source-chat').nextForkOrdinal).toBe(3);
    expect(deps.ownership.delete).toHaveBeenCalledOnce();
    expect(deps.settings.removeFromAllOrderLists).toHaveBeenCalledOnce();
    expect(deps.settings.removeSessionName).toHaveBeenCalledOnce();
    expect(deps.nativeUserIdentities.clearChat).toHaveBeenCalledOnce();
  });
});

function segmentRef(overrides = {}) {
  return {
    id: HEAD_ID,
    agentId: 'test',
    model: 'model-a',
    capturedAt: '2026-08-07T12:00:00.000Z',
    storedMessageCount: 2,
    visibleMessageCount: 2,
    trailingHandoff: { agentId: 'other', model: 'model-b' },
    ...overrides,
  };
}
