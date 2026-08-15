import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptAdoptionService } from '../adoption.ts';
import { TranscriptReloadService } from '../reload.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptReloadService', () => {
  it('atomically replaces the current binding while preserving only the frozen conversation', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, oldViewId }) => {
      const replacement = await reload.reload('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(replacement.viewId).not.toBe(oldViewId);
      expect(replacement.contentStartOrdinal).toBe(3);
      expect(rows.map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
        'user-input',
        'provider-row',
      ]);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'native prompt',
        'native answer',
      ]);
      expect(
        rows.filter((row) => row.kind === 'user-input').map((row) => row.detail.clientMessageId),
      ).toEqual(['frozen-1', null]);
      expect(() => ledger.rowsAfter('chat-1', oldViewId, 0)).toThrow();
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
      expect(lease.closed).toBe(true);
      expect(replacementLease.current?.closed).toBe(false);
    });
  });

  it('rejects queued work before closing the current producer', async () => {
    await withReload(async ({ ledger, reload, lease, execution }) => {
      execution.queueEntries = [{ id: 'queued-1' }];

      await expect(reload.reload('chat-1')).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
      expect(lease.closed).toBe(false);
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
    });
  });

  it('leaves the old view current when native import fails', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, integration }) => {
      integration.nativeHistoryImport.load = async function* load() {
        throw new Error('native read failed');
      };

      await expect(reload.reload('chat-1')).rejects.toThrow('native read failed');
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
      expect(lease.closed).toBe(true);
      expect(replacementLease.current?.closed).toBe(false);

      replacementLease.current.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'output after failed reload') }],
      });
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
      expect(ledger.conversationMessages('chat-1').at(-1)?.content)
        .toBe('output after failed reload');
    });
  });

  it('collects an imported history tail that ends with an unanswered user row', async () => {
    await withReload(async ({ ledger, reload, integration }) => {
      integration.nativeHistoryImport.load = async function* load() {
        yield [{ message: new UserMessage(TS, 'native unanswered prompt') }];
      };

      await reload.reload('chat-1');

      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'native unanswered prompt',
      ]);
      expect(ledger.resendCandidates('chat-1')).toEqual([{
        ordinal: 4,
        content: 'native unanswered prompt',
        attachmentNames: [],
      }]);
    });
  });
});

async function withReload(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-reload-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => 'view-1',
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => TS });
  const old = ledger.initializeChat('chat-1', [
    inputDraft('frozen prompt', 'frozen-1'),
    providerDraft('frozen answer'),
    {
      kind: 'session',
      at: TS,
      detail: {
        agentSessionId: 'session-1',
        nativeSession: { ownerId: 'test', schemaVersion: 1, value: { id: 'native-1' } },
        nativeSeedReceipt: null,
      },
      providerMeta: null,
    },
    inputDraft('old current prompt', 'old-1'),
    providerDraft('old current answer'),
    { kind: 'run-ended', at: TS, outcome: 'finished', origin: 'provider', providerMeta: null },
  ], 3);
  const lease = ledger.openProducer('chat-1', 'test');
  const entry = {
    agentId: 'test',
    agentOwnershipEpoch: 'ownership-1',
    agentSessionId: 'stale-cache',
    nativeSession: null,
    nativeSeedReceipt: null,
    projectPath: '/tmp',
    model: 'model',
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    carryOverSegments: [],
    carryOverMigrationQuarantine: null,
  };
  const integration = {
    descriptor: { id: 'test' },
    settings: { parse: (value) => value },
    nativeHistoryImport: {
      async *load() {
        yield [
          {
            message: new UserMessage(
              TS,
              'native prompt',
              undefined,
              { upstreamRequestId: 'native-message' },
            ),
          },
          { message: new AssistantMessage(TS, 'native answer') },
        ];
      },
    },
  };
  const execution = {
    queueEntries: [],
    reserveTranscriptSnapshot: (chatId) => ({ chatId, reservationId: 'reservation-1' }),
    releaseTranscriptSnapshot: async () => undefined,
    async readChatExecutionControl() {
      return { entries: this.queueEntries };
    },
  };
  const registry = {
    getChat: () => entry,
    updateChat: (_chatId, patch) => Object.assign(entry, patch),
  };
  const integrations = {
    get: () => integration,
    require: () => integration,
  };
  const adoption = new TranscriptAdoptionService({
    ledger,
    registry,
    integrations,
    getCarryOverRevision: () => 'carry-v1:0',
    loadFrozenPrefix: async () => [],
    loadLegacyCurrent: async () => [],
  });
  const replacementLease = { current: null };
  const reload = new TranscriptReloadService({
    ledger,
    adoption,
    registry,
    integrations,
    execution,
    reopenProducer: () => {
      replacementLease.current = ledger.openProducer('chat-1', 'test');
    },
    getCarryOverRevision: () => 'carry-v1:0',
    now: () => TS,
  });
  try {
    await run({
      ledger,
      reload,
      lease,
      replacementLease,
      execution,
      integration,
      oldViewId: old.viewId,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function inputDraft(content, clientMessageId) {
  return {
    kind: 'user-input',
    at: TS,
    detail: {
      clientMessageId,
      message: new UserMessage(TS, content),
      attachments: [],
      steer: false,
    },
    providerMeta: null,
  };
}

function providerDraft(content) {
  return {
    kind: 'provider-row',
    at: TS,
    message: new AssistantMessage(TS, content),
    providerMeta: null,
  };
}
