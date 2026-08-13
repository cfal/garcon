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
  const rows = [
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
      upToSequence: 2,
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
      upToSequence: 2,
      ...deps,
    });

    expect(deps.forkAgentSession).not.toHaveBeenCalled();
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toHaveLength(2);
  });

  it('materializes a native session while retaining the ledger prefix', async () => {
    const deps = makeDeps();

    const result = await forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 2,
      ...deps,
    });

    expect(result.agentSessionId).toBe('target-native');
    expect(deps.forkAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      messageSequence: 2,
    }));
    expect(deps.ledger.initializeChat.mock.calls[0][1]).toEqual([
      expect.objectContaining({ kind: 'user-input' }),
      expect.objectContaining({ kind: 'provider-row' }),
      expect.objectContaining({ kind: 'session' }),
    ]);
    expect(deps.ledger.initializeChat.mock.calls[0][2]).toBe(3);
  });

  it('rejects a point beyond the ledger watermark before creating artifacts', async () => {
    const deps = makeDeps();

    await expect(forkChatFileCopy({
      sourceSession: deps.sessions.get('source-chat'),
      sourceChatId: 'source-chat',
      targetChatId: 'target-chat',
      upToSequence: 4,
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
