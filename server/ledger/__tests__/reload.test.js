import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, ErrorMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptAdoptionService } from '../adoption.ts';
import { TranscriptReloadService } from '../reload.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { KeyedPromiseLock } from '../../lib/keyed-lock.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptReloadService', () => {
  it('[TLV5-L10.02-CORE-UNIT-01] atomically repeats replacement while preserving one frozen conversation prefix', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, oldViewId }) => {
      const firstReplacement = await reload.reload('chat-1');
      const firstReplacementLease = replacementLease.current;
      const replacement = await reload.reload('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(replacement.viewId).not.toBe(oldViewId);
      expect(replacement.viewId).not.toBe(firstReplacement.viewId);
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
      expect(() => ledger.rowsAfter('chat-1', firstReplacement.viewId, 0)).toThrow();
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
      expect(lease.closed).toBe(true);
      expect(firstReplacementLease?.closed).toBe(true);
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

  it('[TLV5-ADOPT.08-RELOAD-CORE-UNIT-01] leaves the old view current when selected native import fails', async () => {
    await withReload(async ({ ledger, reload, lease, replacementLease, integration }) => {
      integration.nativeHistoryImport.load = async function* load() {
        yield [{ message: new UserMessage(TS, 'partial native history') }];
        throw new Error('native iteration failed');
      };

      await expect(reload.reload('chat-1')).rejects.toThrow('native iteration failed');
      expect(ledger.currentView('chat-1')?.viewId).toBe('view-1');
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
        'old current prompt',
        'old current answer',
      ]);
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

  it('[TLV5-ADOPT.08-RELOAD-CORE-UNIT-02] cuts over when the selected native session is validly empty', async () => {
    await withReload(async ({ ledger, reload, integration, oldViewId }) => {
      integration.nativeHistoryImport.load = async function* load() {
        yield [];
      };

      const replacement = await reload.reload('chat-1');

      expect(replacement.viewId).not.toBe(oldViewId);
      expect(replacement.contentStartOrdinal).toBe(3);
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
      ]);
      expect(ledger.conversationMessages('chat-1').map((message) => message.content)).toEqual([
        'frozen prompt',
        'frozen answer',
      ]);
      expect(() => ledger.rowsAfter('chat-1', oldViewId, 0)).toThrow();
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

  it('reloads from a native session fact that arrives after interruption', async () => {
    await withReload(async ({ ledger, reload, lease, integration }) => {
      ledger.beginRun('chat-1', 'run-1');
      ledger.interruptRun('chat-1');
      lease.sink.publish({
        type: 'session',
        session: {
          agentSessionId: 'session-late',
          nativeSession: {
            ownerId: 'test',
            schemaVersion: 1,
            value: { id: 'native-late' },
          },
          nativeSeedReceipt: null,
        },
      });
      let importedChat = null;
      integration.nativeHistoryImport.load = async function* load({ chat }) {
        importedChat = chat;
        yield [];
      };

      const replacement = await reload.reload('chat-1');

      expect(importedChat).toMatchObject({
        agentSessionId: 'session-late',
        nativeSession: {
          ownerId: 'test',
          value: { id: 'native-late' },
        },
      });
      expect(replacement.contentStartOrdinal).toBe(3);
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'user-input',
        'provider-row',
        'session',
      ]);
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-late');
    });
  });

  it('[TLV5-ADOPT.06-CORE-UNIT-01] carries the quarantine notice through reload while dropping ordinary notices', async () => {
    const quarantineDetail = {
      type: 'carryover-migration-quarantine',
      artifactId: 'artifact-1',
      errorCode: 'CARRYOVER_PARSE_FAILED',
    };
    await withReload(async ({ ledger, reload }) => {
      const replacement = await reload.reload('chat-1');
      const notices = ledger.currentRows('chat-1').filter((row) => row.kind === 'notice');

      expect(replacement.contentStartOrdinal).toBe(4);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        message: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
        detail: quarantineDetail,
      });
    }, {
      frozenDrafts: [
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'Ordinary durable notice.',
          detail: { type: 'ordinary-notice' },
        },
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
          detail: quarantineDetail,
        },
      ],
    });
  });

  it('drops chat rows and provider errors from frozen and current bindings during native reload', async () => {
    await withReload(async ({ ledger, reload, lease }) => {
      const currentView = ledger.currentView('chat-1');
      ledger.appendChatRow({
        chatId: 'chat-1',
        viewId: currentView.viewId,
        clientMessageId: 'current-notice',
        presentation: { style: 'notice' },
        format: 'plain',
        content: 'current notice',
      });
      ledger.appendChatRow({
        chatId: 'chat-1',
        viewId: currentView.viewId,
        clientMessageId: 'current-error',
        presentation: { style: 'error' },
        format: 'plain',
        content: 'current error',
      });
      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new ErrorMessage(TS, 'current provider error') }],
      });

      const replacement = await reload.reload('chat-1');
      const rows = ledger.currentRows('chat-1');

      expect(replacement.contentStartOrdinal).toBe(3);
      expect(rows.some((row) => row.kind === 'notice' && row.detail.type === 'cli-row')).toBe(false);
      expect(JSON.stringify(rows)).not.toContain('frozen notice');
      expect(JSON.stringify(rows)).not.toContain('frozen error');
      expect(JSON.stringify(rows)).not.toContain('frozen provider error');
      expect(JSON.stringify(rows)).not.toContain('current notice');
      expect(JSON.stringify(rows)).not.toContain('current error');
      expect(JSON.stringify(rows)).not.toContain('current provider error');
    }, {
      frozenDrafts: [
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'frozen notice',
          detail: {
            type: 'cli-row',
            clientMessageId: 'frozen-notice',
            presentation: { style: 'notice' },
            format: 'plain',
            disclosure: 'expanded',
            title: null,
          },
        },
        {
          kind: 'notice',
          at: TS,
          providerMeta: null,
          message: 'frozen error',
          detail: {
            type: 'cli-row',
            clientMessageId: 'frozen-error',
            presentation: { style: 'error' },
            format: 'plain',
            disclosure: 'expanded',
            title: null,
          },
        },
        {
          kind: 'provider-row',
          at: TS,
          providerMeta: null,
          message: new ErrorMessage(TS, 'frozen provider error'),
        },
      ],
    });
  });

  it('[TLV5-CHAT-ROW.04-RELOAD-INTERLEAVING-CORE-UNIT-01] holds the shared mutation lock through reload cleanup', async () => {
    await withReload(async ({ reload, integration, execution, chatMutationLock }) => {
      const importStarted = deferred();
      const allowImport = deferred();
      const releaseStarted = deferred();
      const allowRelease = deferred();
      integration.nativeHistoryImport.load = async function* () {
        importStarted.resolve();
        await allowImport.promise;
        yield [];
      };
      execution.releaseTranscriptSnapshot = async () => {
        releaseStarted.resolve();
        await allowRelease.promise;
      };

      const reloading = reload.reload('chat-1');
      await importStarted.promise;
      let admitted = false;
      const competing = chatMutationLock.runExclusive('chat:chat-1', async () => {
        admitted = true;
      });
      await Promise.resolve();
      expect(admitted).toBe(false);

      allowImport.resolve();
      await releaseStarted.promise;
      await Promise.resolve();
      expect(admitted).toBe(false);

      allowRelease.resolve();
      await reloading;
      await competing;
      expect(admitted).toBe(true);
    });
  });
});

async function withReload(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-reload-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => 'view-1',
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => TS });
  const frozenDrafts = options.frozenDrafts ?? [];
  const old = ledger.initializeChat('chat-1', [
    inputDraft('frozen prompt', 'frozen-1'),
    providerDraft('frozen answer'),
    ...frozenDrafts,
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
  ], 3 + frozenDrafts.length);
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
  const chatMutationLock = new KeyedPromiseLock();
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
    chatMutationLock,
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
      chatMutationLock,
    });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
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
