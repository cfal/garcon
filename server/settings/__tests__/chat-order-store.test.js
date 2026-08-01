import { describe, expect, it, mock } from 'bun:test';
import { ChatOrderStore } from '../domain-stores.js';

function projectSettings(overrides = {}) {
  return {
    features: { transcriptSearch: { enabled: false } },
    ui: {},
    paths: {},
    chatNames: {},
    remoteSettingsVersion: 0,
    pinnedChatIds: [],
    normalChatIds: [],
    archivedChatIds: [],
    recentAgentSettings: [],
    executionDefaults: {
      global: {
        permissionMode: 'default',
        thinkingMode: 'none',
        agentSettingsById: {},
      },
      byAgent: {},
    },
    chatFolders: [],
    savedChatSearches: [],
    ...overrides,
  };
}

function createHarness(overrides = {}, options = {}) {
  const settings = projectSettings(overrides);
  const saveCalls = [];
  const listChanges = [];
  let mutationTail = Promise.resolve();
  const context = {
    readSettings: () => settings,
    mutate: (operation) => {
      const result = mutationTail.then(operation);
      mutationTail = result.catch(() => undefined);
      return result;
    },
    save: mock(async () => undefined),
    saveAndMaybeEmitRemote: mock(async (_settings, remoteSettingsChanged) => {
      saveCalls.push(remoteSettingsChanged);
      if (options.failSave) throw new Error('save failed');
    }),
    emitSessionNameChanged: mock(() => undefined),
    emitListChanged: mock((reason, chatId) => listChanges.push({ reason, chatId })),
  };
  return {
    settings,
    saveCalls,
    listChanges,
    store: new ChatOrderStore(context),
  };
}

function known(...chatIds) {
  const ids = new Set(chatIds);
  return (chatId) => ids.has(chatId);
}

const groupCases = [
  ['pinned', 'pinnedChatIds'],
  ['normal', 'normalChatIds'],
  ['archived', 'archivedChatIds'],
];

describe('ChatOrderStore.reorderChat', () => {
  for (const [orderGroup, key] of groupCases) {
    for (const boundary of ['top', 'bottom']) {
      it(`moves to the ${boundary} of the ${orderGroup} section`, async () => {
        const harness = createHarness({ [key]: ['a', 'b', 'c'] });

        const result = await harness.store.reorderChat({
          chatId: 'b',
          placement: { kind: 'boundary', boundary },
        }, known('a', 'b', 'c'));

        expect(result).toEqual({
          success: true,
          response: { success: true, chatId: 'b', orderGroup, changed: true },
        });
        expect(harness.settings[key]).toEqual(boundary === 'top'
          ? ['b', 'a', 'c']
          : ['a', 'c', 'b']);
        expect(harness.saveCalls).toEqual([orderGroup === 'pinned']);
        expect(harness.listChanges).toEqual([{ reason: 'chats-reordered', chatId: 'b' }]);
        expect(harness.settings.remoteSettingsVersion).toBe(orderGroup === 'pinned' ? 1 : 0);
      });
    }

    for (const position of ['before', 'after']) {
      it(`places a ${orderGroup} chat ${position} its reference after source removal`, async () => {
        const harness = createHarness({ [key]: ['a', 'b', 'c', 'd'] });

        const result = await harness.store.reorderChat({
          chatId: 'a',
          placement: { kind: 'relative', referenceChatId: 'c', position },
        }, known('a', 'b', 'c', 'd'));

        expect(result.success).toBe(true);
        expect(harness.settings[key]).toEqual(position === 'before'
          ? ['b', 'a', 'c', 'd']
          : ['b', 'c', 'a', 'd']);
      });
    }
  }

  for (const [name, request] of [
    ['top boundary', { chatId: 'a', placement: { kind: 'boundary', boundary: 'top' } }],
    ['bottom boundary', { chatId: 'c', placement: { kind: 'boundary', boundary: 'bottom' } }],
    ['before adjacency', { chatId: 'b', placement: { kind: 'relative', referenceChatId: 'c', position: 'before' } }],
    ['after adjacency', { chatId: 'b', placement: { kind: 'relative', referenceChatId: 'a', position: 'after' } }],
  ]) {
    it(`treats an existing ${name} as side-effect free`, async () => {
      const harness = createHarness({ normalChatIds: ['a', 'b', 'c'] });

      const result = await harness.store.reorderChat(request, known('a', 'b', 'c'));

      expect(result).toEqual({
        success: true,
        response: { success: true, chatId: request.chatId, orderGroup: 'normal', changed: false },
      });
      expect(harness.settings.normalChatIds).toEqual(['a', 'b', 'c']);
      expect(harness.saveCalls).toEqual([]);
      expect(harness.listChanges).toEqual([]);
      expect(harness.settings.remoteSettingsVersion).toBe(0);
    });
  }

  it('reconciles a registry-known orphan source into normal order', async () => {
    const harness = createHarness({ normalChatIds: ['a', 'b'] });

    const result = await harness.store.reorderChat({
      chatId: 'orphan',
      placement: { kind: 'boundary', boundary: 'bottom' },
    }, known('a', 'b', 'orphan'));

    expect(result).toEqual({
      success: true,
      response: { success: true, chatId: 'orphan', orderGroup: 'normal', changed: true },
    });
    expect(harness.settings.normalChatIds).toEqual(['a', 'b', 'orphan']);
  });

  it('reconciles a registry-known orphan reference for a relative normal move', async () => {
    const harness = createHarness({ normalChatIds: ['a', 'b'] });

    const result = await harness.store.reorderChat({
      chatId: 'a',
      placement: { kind: 'relative', referenceChatId: 'orphan', position: 'before' },
    }, known('a', 'b', 'orphan'));

    expect(result.success).toBe(true);
    expect(harness.settings.normalChatIds).toEqual(['b', 'a', 'orphan']);
  });

  it('rejects an unknown source without side effects', async () => {
    const harness = createHarness({ normalChatIds: ['a', 'b'] });

    const result = await harness.store.reorderChat({
      chatId: 'missing',
      placement: { kind: 'boundary', boundary: 'top' },
    }, known('a', 'b'));

    expect(result).toMatchObject({ success: false, errorCode: 'SESSION_NOT_FOUND', status: 404 });
    expect(harness.settings.normalChatIds).toEqual(['a', 'b']);
    expect(harness.saveCalls).toEqual([]);
    expect(harness.listChanges).toEqual([]);
  });

  it('rejects an unknown reference without side effects', async () => {
    const harness = createHarness({ normalChatIds: ['a', 'b'] });

    const result = await harness.store.reorderChat({
      chatId: 'a',
      placement: { kind: 'relative', referenceChatId: 'missing', position: 'after' },
    }, known('a', 'b'));

    expect(result).toMatchObject({ success: false, errorCode: 'SESSION_NOT_FOUND', status: 404 });
    expect(harness.settings.normalChatIds).toEqual(['a', 'b']);
    expect(harness.saveCalls).toEqual([]);
  });

  it('rejects cross-group placement and rolls back orphan reconciliation', async () => {
    const harness = createHarness({ pinnedChatIds: ['a'], normalChatIds: ['b'] });

    const result = await harness.store.reorderChat({
      chatId: 'a',
      placement: { kind: 'relative', referenceChatId: 'orphan', position: 'after' },
    }, known('a', 'b', 'orphan'));

    expect(result).toEqual({
      success: false,
      error: 'Cross-group reorder is not allowed',
      errorCode: 'ORDER_CROSS_GROUP',
      status: 400,
    });
    expect(harness.settings.pinnedChatIds).toEqual(['a']);
    expect(harness.settings.normalChatIds).toEqual(['b']);
    expect(harness.saveCalls).toEqual([]);
    expect(harness.listChanges).toEqual([]);
  });

  it('self-heals duplicate membership using pinned-first precedence', async () => {
    const harness = createHarness({
      pinnedChatIds: ['a', 'a', 'b'],
      normalChatIds: ['a', 'c'],
      archivedChatIds: ['a', 'd'],
    });

    const result = await harness.store.reorderChat({
      chatId: 'a',
      placement: { kind: 'boundary', boundary: 'bottom' },
    }, known('a', 'b', 'c', 'd'));

    expect(result.response.orderGroup).toBe('pinned');
    expect(harness.settings.pinnedChatIds).toEqual(['b', 'a']);
    expect(harness.settings.normalChatIds).toEqual(['c']);
    expect(harness.settings.archivedChatIds).toEqual(['d']);
    expect(harness.settings.remoteSettingsVersion).toBe(1);
    expect(harness.saveCalls).toEqual([true]);
  });

  it('serializes queued boundary mutations in invocation order', async () => {
    const harness = createHarness({ normalChatIds: ['a', 'b', 'c'] });

    const first = harness.store.reorderChat({
      chatId: 'c',
      placement: { kind: 'boundary', boundary: 'top' },
    }, known('a', 'b', 'c'));
    const second = harness.store.reorderChat({
      chatId: 'a',
      placement: { kind: 'boundary', boundary: 'bottom' },
    }, known('a', 'b', 'c'));

    await Promise.all([first, second]);
    expect(harness.settings.normalChatIds).toEqual(['c', 'b', 'a']);
    expect(harness.saveCalls).toEqual([false, false]);
  });

  it('does not emit a success invalidation when persistence fails', async () => {
    const harness = createHarness({ normalChatIds: ['a', 'b'] }, { failSave: true });

    await expect(harness.store.reorderChat({
      chatId: 'b',
      placement: { kind: 'boundary', boundary: 'top' },
    }, known('a', 'b'))).rejects.toThrow('save failed');

    expect(harness.listChanges).toEqual([]);
  });
});
