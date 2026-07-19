import { describe, expect, it, mock } from 'bun:test';

import { forkChatFileCopy } from '../fork-chat.js';

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
    stageFork: mock(async () => undefined),
    promoteStaged: mock(async () => undefined),
    discardStaged: mock(async () => undefined),
  };
  const ownership = overrides.ownership ?? {
    delete: mock(async (chatId) => {
      sessions.delete(chatId);
    }),
  };
  const forkAgentSession = overrides.forkAgentSession ?? mock(async () => ({
    agentSessionId: 'target-native',
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'target-native' } },
  }));
  return {
    registry,
    settings,
    metadata,
    carryOver,
    ownership,
    forkAgentSession,
    sessions,
  };
}

describe('forkChatFileCopy', () => {
  it('stages the exact combined cutoff and activates it under the target ownership epoch', async () => {
    const deps = makeDeps();

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 3,
      ...deps,
    });

    expect(result).toEqual({
      sourceChatId: 'source-chat',
      chatId: 'target-chat',
      agentId: 'test',
      agentSessionId: 'target-native',
      sourceNextForkOrdinal: 1,
      rollback: expect.any(Function),
    });
    expect(deps.carryOver.stageFork).toHaveBeenCalledWith({
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      targetEpoch: expect.any(String),
      ownerId: 'test',
      ownerModel: 'model-a',
      upToSequence: 3,
    });
    expect(deps.forkAgentSession).toHaveBeenCalledWith({
      sourceSession: expect.objectContaining({
        agentId: 'test',
        agentSessionId: 'source-native',
        agentOwnershipEpoch: 'source-epoch',
      }),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      messageSequence: 3,
    });
    const target = deps.sessions.get('target-chat');
    expect(target).toMatchObject({
      agentId: 'test',
      agentSessionId: 'target-native',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'target-native' } },
      agentOwnershipEpoch: expect.any(String),
      agentSettingsById: {
        test: envelope('test', { mode: 'careful' }),
        other: envelope('other', { retained: true }),
      },
      model: 'model-a',
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
    });
    expect(deps.registry.flush).toHaveBeenCalled();
    expect(deps.carryOver.promoteStaged).toHaveBeenCalledWith(
      'target-chat',
      target.agentOwnershipEpoch,
    );
    expect(deps.settings.setSessionName).toHaveBeenCalledWith('target-chat', 'Source title (1)');
    expect(deps.metadata.addNewChatMetadata).toHaveBeenCalledWith('target-chat', 'First prompt');
  });

  it('discards inactive carry-over when the integration fork fails', async () => {
    const failure = new Error('native fork failed');
    const deps = makeDeps({ forkAgentSession: mock(async () => { throw failure; }) });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toBe(failure);

    expect(deps.carryOver.discardStaged).toHaveBeenCalledWith('target-chat', expect.any(String));
    expect(deps.registry.addChat).not.toHaveBeenCalled();
  });

  it('discards inactive carry-over when the integration returns no target', async () => {
    const deps = makeDeps({ forkAgentSession: mock(async () => null) });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toThrow('Failed to create fork target');

    expect(deps.carryOver.discardStaged).toHaveBeenCalledWith('target-chat', expect.any(String));
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

    expect(deps.sessions.get('target-chat')).toBeDefined();
    expect(deps.sessions.get('source-chat').nextForkOrdinal).toBe(4);
    await result.rollback();
    await result.rollback();

    expect(deps.sessions.get('target-chat')).toBeUndefined();
    expect(deps.sessions.get('source-chat').nextForkOrdinal).toBe(3);
    expect(deps.ownership.delete).toHaveBeenCalledOnce();
    expect(deps.settings.removeFromAllOrderLists).toHaveBeenCalledOnce();
    expect(deps.settings.removeSessionName).toHaveBeenCalledOnce();
  });

  it('rolls back through integration ownership when target setup fails', async () => {
    const failure = new Error('settings failed');
    const deps = makeDeps({
      source: sourceSession({ nextForkOrdinal: 3 }),
      settings: { setSessionName: mock(async () => { throw failure; }) },
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toBe(failure);

    expect(deps.ownership.delete).toHaveBeenCalledWith('target-chat');
    expect(deps.sessions.get('target-chat')).toBeUndefined();
    expect(deps.sessions.get('source-chat').nextForkOrdinal).toBe(3);
  });
});
