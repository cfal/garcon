import { describe, expect, it, mock } from 'bun:test';
import { UserMessage, AssistantMessage } from '../../../common/chat-types.js';
import { forkChatFileCopy } from '../fork-chat.js';
import { transcriptViewId } from '../../ledger/contracts.js';

const envelope = (ownerId, values = {}) => ({ ownerId, schemaVersion: 1, values });

function sourceSession(overrides = {}) {
  return {
    id: 'source-chat',
    agentId: 'test',
    agentSessionId: 'source-native',
    nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'source-native' } },
    agentOwnershipEpoch: 'source-epoch',
    agentSettingsById: { test: envelope('test', { mode: 'careful' }) },
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
  const targetViews = new Set();
  const rows = overrides.rows ?? [
    userRow(1, 'first'),
    providerRow(2, 'answer'),
    userRow(3, 'second'),
  ];
  const ledger = {
    currentView: mock((chatId) => targetViews.has(chatId)
      ? { viewId: `view-${chatId}`, contentStartOrdinal: 1 }
      : chatId === 'source-chat'
        ? { viewId: 'source-view', contentStartOrdinal: 1 }
        : null),
    highWatermark: mock(() => ({ viewId: transcriptViewId('source-view'), ordinal: rows.length })),
    rowsThrough: mock((_chatId, watermark) => rows.slice(0, watermark.ordinal)),
    initializeChat: mock((chatId, drafts, contentStartOrdinal) => {
      targetViews.add(chatId);
      return { viewId: `view-${chatId}`, drafts, contentStartOrdinal };
    }),
    deleteChat: mock((chatId) => targetViews.delete(chatId)),
    ...overrides.ledger,
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
  const ownership = overrides.ownership ?? {
    delete: mock(async (chatId) => {
      sessions.delete(chatId);
      ledger.deleteChat(chatId);
    }),
  };
  const forkAgentSession = overrides.forkAgentSession ?? mock(async () => ({
    kind: 'materialized',
    session: {
      agentSessionId: 'target-native',
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'target-native' } },
      nativeSeedReceipt: null,
    },
  }));
  return {
    registry,
    settings,
    metadata,
    ledger,
    ownership,
    forkAgentSession,
    discardForkedAgentSession: overrides.discardForkedAgentSession
      ?? mock(async () => undefined),
    readForkedNativeHistory: overrides.readForkedNativeHistory ?? mock(async () => null),
    sessions,
  };
}

describe('forkChatFileCopy', () => {
  it('builds the frozen target ledger before registering the chat', async () => {
    const deps = makeDeps({ source: sourceSession({ agentSessionId: null, nativeSession: null }) });
    const order = [];
    deps.ledger.initializeChat.mockImplementation((...args) => {
      order.push('ledger');
      return { viewId: 'target-view', args };
    });
    deps.registry.addChat.mockImplementation((entry) => {
      order.push('registry');
      deps.sessions.set(entry.id, entry);
      return true;
    });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    });

    expect(order).toEqual(['ledger', 'registry']);
    expect(deps.ledger.initializeChat).toHaveBeenCalledWith(
      'target-chat',
      [expect.objectContaining({ kind: 'user-input' }),
        expect.objectContaining({ kind: 'provider-row' }),
        expect.objectContaining({ kind: 'user-input' })],
      4,
    );
    expect(deps.sessions.get('target-chat')).toMatchObject({
      agentSessionId: null,
      carryOverSegments: [],
    });
  });

  it('copies only rows through the selected ordinal', async () => {
    const deps = makeDeps({ source: sourceSession({ agentSessionId: null, nativeSession: null }) });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 2,
      ...deps,
    });

    expect(deps.ledger.rowsThrough).toHaveBeenCalledWith('source-chat', {
      viewId: 'source-view',
      ordinal: 2,
    });
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toHaveLength(2);
  });

  it('does not fork the current native session for a point in the frozen prefix', async () => {
    const deps = makeDeps({
      ledger: {
        currentView: mock((chatId) => chatId === 'source-chat'
          ? { viewId: 'source-view', contentStartOrdinal: 3 }
          : null),
      },
    });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 2,
      ...deps,
    });

    expect(deps.forkAgentSession).not.toHaveBeenCalled();
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toHaveLength(2);
  });

  it('resolves a core-authored row to the provider row before it', async () => {
    const deps = makeDeps();

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 3,
      ...deps,
    });

    // Row 3 is a user input with no provider identity, so the point resolves back to the
    // provider row at ordinal 2 rather than asking the user about a handoff fork.
    expect(deps.forkAgentSession).toHaveBeenCalledTimes(1);
    expect(deps.forkAgentSession.mock.calls[0][0]).toMatchObject({
      messageOrdinal: 3,
      providerMeta: { native: true },
    });
    // Three frozen conversational rows plus the session the integration handed back.
    const drafts = deps.ledger.initializeChat.mock.calls[0][1];
    expect(drafts).toHaveLength(4);
    expect(drafts.at(-1)).toMatchObject({ kind: "session" });
  });

  it('materializes a native session while retaining the ledger prefix', async () => {
    const deps = makeDeps();

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 2,
      ...deps,
    });

    expect(result.agentSessionId).toBe('target-native');
    expect(deps.forkAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      messageOrdinal: 2,
      providerMeta: { native: true },
    }));
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toEqual([
      expect.objectContaining({ kind: 'user-input' }),
      expect.objectContaining({ kind: 'provider-row' }),
      expect.objectContaining({ kind: 'session' }),
    ]);
    expect(deps.ledger.initializeChat.mock.calls[0][2]).toBe(3);
  });

  it('hands the facet an uncorrelated provider row rather than an older settled one', async () => {
    const streamed = { ...providerRow(3, 'streaming'), providerMeta: null };
    const deps = makeDeps({ rows: [userRow(1, 'first'), providerRow(2, 'answer'), streamed] });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 3,
      ...deps,
    });

    // Resolving back to row 2 would fork from a point the user did not choose; the empty
    // identity has to reach the integration so it can refuse.
    expect(deps.forkAgentSession.mock.calls[0][0]).toMatchObject({
      messageOrdinal: 3,
      providerMeta: null,
    });
  });

  it('does not silently substitute a handoff fork for an unmaterialized whole-chat fork', async () => {
    const deps = makeDeps({
      forkAgentSession: mock(async () => ({ kind: 'unmaterialized' })),
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      allowHandoffFork: false,
      ...deps,
    })).rejects.toBeDefined();

    expect(deps.ledger.initializeChat).not.toHaveBeenCalled();
    expect(deps.registry.addChat).not.toHaveBeenCalled();
  });

  it('uses an unmaterialized whole-chat fork only after handoff-fork consent', async () => {
    const deps = makeDeps({
      forkAgentSession: mock(async () => ({ kind: 'unmaterialized' })),
    });

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      allowHandoffFork: true,
      ...deps,
    });

    expect(result.agentSessionId).toBeNull();
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toEqual([
      expect.objectContaining({ kind: 'user-input' }),
      expect.objectContaining({ kind: 'provider-row' }),
      expect.objectContaining({ kind: 'user-input' }),
    ]);
  });

  it('retries an unmaterialized fork as native when the provider later materializes it', async () => {
    let attempt = 0;
    const deps = makeDeps({
      forkAgentSession: mock(async () => {
        attempt += 1;
        if (attempt === 1) return { kind: 'unmaterialized' };
        return {
          kind: 'materialized',
          session: {
            agentSessionId: 'target-native-after-retry',
            nativeSession: {
              ownerId: 'test',
              schemaVersion: 1,
              value: { id: 'target-native-after-retry' },
            },
            nativeSeedReceipt: null,
          },
        };
      }),
    });
    const request = {
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      allowHandoffFork: false,
      ...deps,
    };

    await expect(forkChatFileCopy(request)).rejects.toBeDefined();
    expect(deps.registry.addChat).not.toHaveBeenCalled();

    const result = await forkChatFileCopy(request);

    expect(result.agentSessionId).toBe('target-native-after-retry');
    expect(deps.forkAgentSession).toHaveBeenCalledTimes(2);
    expect(deps.ledger.initializeChat).toHaveBeenCalledOnce();
    expect(deps.registry.addChat).toHaveBeenCalledOnce();
  });

  it('seeds a native fork from the forked session instead of the source rows', async () => {
    const imported = [
      { kind: 'user-input', at: '2026-08-07T12:00:00.000Z', detail: { clientMessageId: null, message: {}, attachments: [], steer: false }, providerMeta: { native: 'imported' } },
      { kind: 'provider-row', at: '2026-08-07T12:00:01.000Z', message: {}, providerMeta: { native: 'imported' } },
    ];
    const deps = makeDeps({ readForkedNativeHistory: mock(async () => imported) });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 2,
      ...deps,
    });

    expect(deps.readForkedNativeHistory).toHaveBeenCalledWith(expect.objectContaining({
      targetChatId: 'target-chat',
      fork: expect.objectContaining({ agentSessionId: 'target-native' }),
    }));
    // Rows below the source content start are earlier-agent history no provider ever held,
    // so they survive alongside the imported current binding.
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toEqual([
      expect.objectContaining({ kind: 'session' }),
      ...imported,
    ]);
    expect(deps.ledger.initializeChat.mock.calls[0][2]).toBe(1);
  });

  it('keeps earlier-agent history below the content start when seeding natively', async () => {
    const imported = [
      { kind: 'provider-row', at: '2026-08-07T12:00:01.000Z', message: {}, providerMeta: { native: 'imported' } },
    ];
    const deps = makeDeps({
      readForkedNativeHistory: mock(async () => imported),
      ledger: {
        currentView: mock((chatId) => (chatId === 'source-chat'
          ? { viewId: 'source-view', contentStartOrdinal: 2 }
          : null)),
      },
    });

    await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 2,
      ...deps,
    });

    expect(deps.ledger.initializeChat.mock.calls[0][1]).toEqual([
      expect.objectContaining({ kind: 'user-input' }),
      expect.objectContaining({ kind: 'session' }),
      ...imported,
    ]);
    expect(deps.ledger.initializeChat.mock.calls[0][2]).toBe(2);
  });

  it('discards the fork when its native history cannot be read', async () => {
    const deps = makeDeps({
      readForkedNativeHistory: mock(async () => { throw new Error('history unreadable'); }),
    });

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 2,
      ...deps,
    })).rejects.toThrow('history unreadable');

    expect(deps.ledger.initializeChat).not.toHaveBeenCalled();
    expect(deps.discardForkedAgentSession).toHaveBeenCalledOnce();
  });

  it('rejects a point beyond the ledger watermark before creating artifacts', async () => {
    const deps = makeDeps();

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToOrdinal: 4,
      ...deps,
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE', status: 422 });

    expect(deps.forkAgentSession).not.toHaveBeenCalled();
    expect(deps.ledger.initializeChat).not.toHaveBeenCalled();
  });

  it('deletes an orphan target ledger when registry publication fails', async () => {
    const deps = makeDeps();
    deps.registry.addChat.mockReturnValue(false);

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      ...deps,
    })).rejects.toThrow('Chat ID collision');

    expect(deps.ledger.deleteChat).toHaveBeenCalledWith('target-chat');
    expect(deps.discardForkedAgentSession).toHaveBeenCalledOnce();
  });

  it('rolls back registry, ledger, presentation, and native artifacts once', async () => {
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
    expect(deps.discardForkedAgentSession).toHaveBeenCalledOnce();
  });
});

function userRow(ordinal, content) {
  const message = new UserMessage('2026-08-07T12:00:00.000Z', content);
  return {
    kind: 'user-input',
    viewId: transcriptViewId('source-view'),
    ordinal,
    at: message.timestamp,
    detail: { clientMessageId: `message-${ordinal}`, message, attachments: [], steer: false },
    providerMeta: null,
  };
}

function providerRow(ordinal, content) {
  const message = new AssistantMessage('2026-08-07T12:00:00.000Z', content);
  return {
    kind: 'provider-row',
    viewId: transcriptViewId('source-view'),
    ordinal,
    at: message.timestamp,
    message,
    providerMeta: { native: true },
  };
}
