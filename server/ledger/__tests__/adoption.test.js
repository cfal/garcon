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
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
    });
  });

  it('drops legacy permission lifecycle instead of importing transient V4 controls', async () => {
    await withFixture(async ({ ledger, adoption, setCurrent }) => {
      setCurrent([
        new PermissionRequestMessage(
          TS,
          'permission-1',
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
  let current = [new UserMessage(TS, 'current'), new AssistantMessage(TS, 'answer')];
  const loadCounts = { prefix: 0, current: 0 };
  const integration = {
    descriptor: { id: 'test' },
    settings: {
      defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }),
      parse: (value) => value,
    },
    nativeHistoryImport: null,
  };
  const adoption = new TranscriptAdoptionService({
    ledger,
    registry: { getChat: () => entry },
    integrations: { require: () => integration },
    getCarryOverRevision: () => 'carryover-1',
    async loadFrozenPrefix() {
      loadCounts.prefix += 1;
      return [new UserMessage(TS, 'prefix'), new AssistantMessage(TS, 'prefix answer')];
    },
    async loadLegacyCurrent() {
      loadCounts.current += 1;
      return current;
    },
    now: () => TS,
  });
  try {
    await run({
      ledger,
      adoption,
      loadCounts,
      setCurrent(value) { current = value; },
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
