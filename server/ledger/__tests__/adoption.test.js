import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  BashToolUseMessage,
  PermissionRequestMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { TranscriptAdoptionService } from '../adoption.ts';
import { transcriptViewId } from '../contracts.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptAdoptionService', () => {
  it('preserves the served conversational prefix and establishes the current binding boundary', async () => {
    await withFixture(async ({ ledger, adoption }) => {
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
      expect(
        rows.filter((row) => row.kind === 'user-input').map((row) => row.detail.clientMessageId),
      ).toEqual(['prefix-message', null]);
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
    });
  });

  it('drops legacy permission lifecycle instead of importing transient V4 controls', async () => {
    await withFixture(async ({ ledger, adoption, setCurrent }) => {
      setCurrent([
        new PermissionRequestMessage(
          TS,
          'incarnation-1',
          new BashToolUseMessage(TS, 'tool-1', 'pwd'),
        ),
        new AssistantMessage(TS, 'answer'),
      ]);

      await adoption.ensure('chat-1');
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
        'provider-row',
      ]);
    });
  });

  it('runs lazy adoption only once under concurrent first opens', async () => {
    await withFixture(async ({ adoption, loadCounts }) => {
      const [first, second] = await Promise.all([
        adoption.ensure('chat-1'),
        adoption.ensure('chat-1'),
      ]);

      expect(first.viewId).toBe(second.viewId);
      expect(loadCounts).toEqual({ prefix: 1, current: 1 });
    });
  });

  it('repairs stale registry session fields from an existing ledger on open', async () => {
    await withFixture(async ({ adoption, ledger, entry, updates }) => {
      await adoption.ensure('chat-1');
      ledger.openProducer('chat-1', 'test').sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'session-2',
          nativeSession: {
            ownerId: 'test',
            schemaVersion: 1,
            value: { path: '/private/session-2.jsonl' },
          },
          nativeSeedReceipt: null,
        },
      });
      entry.agentSessionId = 'session-1';
      entry.nativeSession = null;
      updates.length = 0;

      await adoption.ensure('chat-1');

      expect(updates).toEqual([{
        agentSessionId: 'session-2',
        nativeSession: {
          ownerId: 'test',
          schemaVersion: 1,
          value: { path: '/private/session-2.jsonl' },
        },
        nativeSeedReceipt: null,
      }]);
      expect(entry.agentSessionId).toBe('session-2');
    });
  });
});

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-adoption-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => TS });
  const entry = {
    agentId: 'test',
    agentSessionId: 'session-1',
    nativeSession: null,
    nativeSeedReceipt: null,
    agentOwnershipEpoch: 'owner-1',
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    projectPath: '/tmp/project',
    model: 'model',
    permissionMode: 'default',
    thinkingMode: 'medium',
    carryOverSegments: [],
  };
  let current = [
    new UserMessage(TS, 'current', undefined, { upstreamRequestId: 'native-message' }),
    new AssistantMessage(TS, 'answer'),
  ];
  const loadCounts = { prefix: 0, current: 0 };
  const updates = [];
  const integration = {
    descriptor: { id: 'test' },
    settings: {
      defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }),
      parse: (value) => value,
    },
    legacyHistoryImport: {
      async *load() {
        loadCounts.current += 1;
        yield current.map((message) => ({ message }));
      },
    },
  };
  const adoption = new TranscriptAdoptionService({
    ledger,
    registry: {
      getChat: () => entry,
      updateChat(_chatId, patch) {
        updates.push(patch);
        Object.assign(entry, patch);
        return { id: 'chat-1', ...entry };
      },
    },
    integrations: { require: () => integration },
    getCarryOverRevision: () => 'carryover-1',
    async loadFrozenPrefix() {
      loadCounts.prefix += 1;
      return [
        new UserMessage(TS, 'prefix', undefined, { upstreamRequestId: 'prefix-message' }),
        new AssistantMessage(TS, 'prefix answer'),
      ];
    },
    now: () => TS,
  });
  try {
    await run({
      ledger,
      adoption,
      entry,
      loadCounts,
      updates,
      setCurrent(value) { current = value; },
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
