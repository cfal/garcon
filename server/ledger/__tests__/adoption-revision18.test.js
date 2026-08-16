import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptAdoptionService } from '../adoption.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const AT = '2026-08-16T00:00:00.000Z';

describe('TranscriptAdoptionService Revision 18 contract', () => {
  it('[TLV5-ADOPT.01-CORE-UNIT-01] accepts null and explicit-empty legacy sources without consulting Reload', async () => {
    for (const legacyHistoryImport of [null, historyImport(async function* load() {})]) {
      let nativeCalls = 0;
      await withFixture({
        legacyHistoryImport,
        nativeHistoryImport: historyImport(async function* load() {
          nativeCalls += 1;
          throw new Error('Reload history must not serve genesis adoption');
        }),
        loadFrozenPrefix: async () => [],
      }, async ({ adoption, ledger }) => {
        await expect(adoption.ensure('chat-1')).resolves.toMatchObject({
          status: 'current',
          contentStartOrdinal: 1,
        });
        expect(nativeCalls).toBe(0);
        expect(ledger.currentRows('chat-1')).toEqual([]);
      });
    }
  });

  it('[TLV5-ADOPT.02-CORE-UNIT-01] leaves no view after prefix failure and retries without blocking another chat', async () => {
    const failingPrefixes = new Set(['chat-1']);
    const legacyCalls = [];
    await withFixture({
      chatIds: ['chat-1', 'chat-2'],
      legacyHistoryImport: historyImport(async function* load({ chat }) {
        legacyCalls.push(chat.chatId);
      }),
      nativeHistoryImport: forbiddenReloadImport(),
      async loadFrozenPrefix(chatId) {
        if (failingPrefixes.has(chatId)) throw new Error('frozen prefix unavailable');
        return [];
      },
    }, async ({ adoption, ledger }) => {
      await expect(adoption.ensure('chat-1')).rejects.toThrow('frozen prefix unavailable');
      expect(ledger.currentView('chat-1')).toBeNull();
      expect(legacyCalls).toEqual([]);

      await expect(adoption.ensure('chat-2')).resolves.toMatchObject({ status: 'current' });
      expect(ledger.currentView('chat-2')).not.toBeNull();

      failingPrefixes.delete('chat-1');
      await expect(adoption.ensure('chat-1')).resolves.toMatchObject({ status: 'current' });
      expect(legacyCalls).toEqual(['chat-2', 'chat-1']);
    });
  });

  it('[TLV5-ADOPT.02-CORE-UNIT-02] commits no partial view when legacy iteration fails and retries the source', async () => {
    let attempt = 0;
    await withFixture({
      legacyHistoryImport: historyImport(async function* load() {
        attempt += 1;
        yield [{ message: new AssistantMessage(AT, `attempt-${attempt}`) }];
        if (attempt === 1) throw new Error('legacy iteration failed');
      }),
      nativeHistoryImport: forbiddenReloadImport(),
      loadFrozenPrefix: async () => [],
    }, async ({ adoption, ledger }) => {
      await expect(adoption.ensure('chat-1')).rejects.toThrow('legacy iteration failed');
      expect(ledger.currentView('chat-1')).toBeNull();
      expect(() => ledger.currentRows('chat-1'))
        .toThrow('Transcript ledger has no current view for chat chat-1');

      await expect(adoption.ensure('chat-1')).resolves.toMatchObject({ status: 'current' });
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'attempt-2',
      ]);
      expect(attempt).toBe(2);
    });
  });

  it('[TLV5-ADOPT.03-CORE-UNIT-01] orders the frozen prefix, current session boundary, and legacy rows exactly', async () => {
    await withFixture({
      entry: {
        agentSessionId: 'session-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
      },
      legacyHistoryImport: historyImport(async function* load() {
        yield [
          { message: new UserMessage(AT, 'legacy prompt') },
          { message: new AssistantMessage(AT, 'legacy answer') },
        ];
      }),
      nativeHistoryImport: forbiddenReloadImport(),
      loadFrozenPrefix: async () => [
        new UserMessage(AT, 'frozen prompt', undefined, { upstreamRequestId: 'frozen-1' }),
        new AssistantMessage(AT, 'frozen answer'),
      ],
    }, async ({ adoption, ledger }) => {
      const view = await adoption.ensure('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(view.contentStartOrdinal).toBe(3);
      expect(rows.map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
        'user-input',
        'provider-row',
      ]);
      expect(rows.map(rowText)).toEqual([
        'frozen prompt',
        'frozen answer',
        null,
        'legacy prompt',
        'legacy answer',
      ]);
      expect(rows.filter((row) => row.kind === 'user-input').map(
        (row) => row.detail.clientMessageId,
      )).toEqual(['frozen-1', null]);
      expect(ledger.currentSession('chat-1')?.ordinal).toBe(3);
    });
  });

  it('[TLV5-ADOPT.04-CORE-UNIT-01] turns recorded quarantine into a usable warning before the current binding', async () => {
    let prefixCalls = 0;
    const quarantine = {
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
    };
    await withFixture({
      entry: {
        agentSessionId: 'session-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
        carryOverMigrationQuarantine: quarantine,
      },
      legacyHistoryImport: historyImport(async function* load() {
        yield [{ message: new AssistantMessage(AT, 'supported legacy row') }];
      }),
      nativeHistoryImport: forbiddenReloadImport(),
      async loadFrozenPrefix() {
        prefixCalls += 1;
        throw new Error('quarantined prefix must not be read');
      },
    }, async ({ adoption, ledger, entries }) => {
      const view = await adoption.ensure('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(prefixCalls).toBe(0);
      expect(view.contentStartOrdinal).toBe(2);
      expect(rows.map((row) => row.kind)).toEqual(['notice', 'session', 'provider-row']);
      expect(rows[0]).toMatchObject({
        message: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
        detail: {
          type: 'carryover-migration-quarantine',
          artifactId: 'artifact-1',
          errorCode: 'CARRYOVER_PARSE_FAILED',
        },
      });
      expect(rows[2]).toMatchObject({ message: { content: 'supported legacy row' } });
      expect(entries.get('chat-1').carryOverMigrationQuarantine).toEqual(quarantine);
    });
  });
});

async function withFixture(options, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-adoption-revision18-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => `view-${crypto.randomUUID()}`,
    now: () => AT,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => AT });
  const entries = new Map((options.chatIds ?? ['chat-1']).map((chatId) => [
    chatId,
    makeEntry(chatId, options.entry),
  ]));
  const integration = {
    descriptor: { id: 'test' },
    settings: {
      defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }),
      parse: (value) => value,
    },
    legacyHistoryImport: options.legacyHistoryImport,
    nativeHistoryImport: options.nativeHistoryImport,
  };
  const adoption = new TranscriptAdoptionService({
    ledger,
    registry: {
      getChat: (chatId) => entries.get(chatId) ?? null,
      updateChat(chatId, patch) {
        const entry = entries.get(chatId);
        if (!entry) throw new Error(`Unknown chat ${chatId}`);
        Object.assign(entry, patch);
        return { id: chatId, ...entry };
      },
    },
    integrations: { require: () => integration },
    getCarryOverRevision: () => 'carryover-1',
    loadFrozenPrefix: options.loadFrozenPrefix,
    now: () => AT,
  });
  try {
    await run({ adoption, entries, ledger });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function makeEntry(chatId, overrides = {}) {
  return {
    agentId: 'test',
    agentSessionId: null,
    nativeSession: null,
    nativeSeedReceipt: null,
    agentOwnershipEpoch: `owner-${chatId}`,
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    projectPath: '/tmp/project',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'medium',
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
    ...overrides,
  };
}

function historyImport(load) {
  return { load };
}

function forbiddenReloadImport() {
  return historyImport(async function* load() {
    throw new Error('Reload history must not serve genesis adoption');
  });
}

function rowText(row) {
  if (row.kind === 'user-input') return row.detail.message.content;
  if (row.kind === 'provider-row') return row.message.content;
  return null;
}
