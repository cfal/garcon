import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { transcriptViewId } from '../contracts.ts';
import { TranscriptLedgerService, TranscriptSinkClosedError } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptLedgerService', () => {
  it('commits producer events synchronously and notifies after publish returns', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1');
      const notifications = [];
      ledger.subscribe((event) => notifications.push(event));

      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'answer') }],
      });

      expect(ledger.currentRows('chat-1')).toHaveLength(1);
      expect(notifications).toEqual([]);
      await tick();
      expect(notifications).toHaveLength(1);
    });
  });

  it('uses the sink object as the ownership fence', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const old = ledger.openProducer('chat-1');
      old.close();
      const current = ledger.openProducer('chat-1');

      expect(() => old.sink.publish({ type: 'rows', rows: [] }))
        .toThrow(TranscriptSinkClosedError);
      current.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'current') }],
      });
      expect(ledger.conversationMessages('chat-1').map((message) => message.content))
        .toEqual(['current']);
    });
  });

  it('ignores stale terminals while retaining late content and session facts', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1');
      ledger.beginRun('chat-1', 'run-1');
      expect(ledger.interruptRun('chat-1')?.outcome).toBe('interrupted');
      ledger.beginRun('chat-1', 'run-2');

      lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
      lease.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'late') }],
      });
      lease.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      });

      expect(ledger.activeRunId('chat-1')).toBe('run-2');
      expect(ledger.currentRows('chat-1').map((row) => row.kind)).toEqual([
        'run-ended',
        'provider-row',
        'session',
      ]);
      expect(ledger.currentSession('chat-1')?.detail.agentSessionId).toBe('session-1');
    });
  });

  it('records a core failure once and ignores the later provider end', async () => {
    await withService(async ({ ledger }) => {
      ledger.initializeChat('chat-1');
      const lease = ledger.openProducer('chat-1');
      ledger.beginRun('chat-1', 'run-1');

      ledger.failRun('chat-1', 'run-1', { code: 'PROVIDER_FAILURE', message: 'launch failed' });
      lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'failed' });

      expect(ledger.currentRows('chat-1')).toMatchObject([{
        kind: 'run-ended',
        origin: 'core',
        error: { code: 'PROVIDER_FAILURE', message: 'launch failed' },
      }]);
    });
  });

  it('commits an input and its resend composition as one synchronous operation', async () => {
    await withService(async ({ ledger }) => {
      const view = ledger.initializeChat('chat-1');
      const first = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'first'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      ledger.openProducer('chat-1');
      ledger.beginRun('chat-1', 'run-1');
      ledger.interruptRun('chat-1');
      const second = ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId: view.viewId,
        message: new UserMessage(TS, 'second'),
        attachments: [],
        clientMessageId: 'message-2',
        steer: false,
      });

      expect(first.prompt.map((row) => row.detail.message.content)).toEqual(['first']);
      expect(second.prompt.map((row) => row.detail.message.content)).toEqual(['first', 'second']);
    });
  });

  it('qualifies reload cutover notifications by both transcript views', async () => {
    await withService(async ({ ledger, store }) => {
      const current = ledger.initializeChat('chat-1');
      const stagingId = transcriptViewId('view-2');
      store.stageView('chat-1', { viewId: stagingId, contentStartOrdinal: 1 });
      const events = [];
      ledger.subscribe((event) => events.push(event));

      const replacement = ledger.replaceCurrentView('chat-1', current.viewId, stagingId);
      await tick();

      expect(events).toEqual([{
        type: 'view-replaced',
        chatId: 'chat-1',
        previousViewId: current.viewId,
        view: replacement,
      }]);
    });
  });
});

async function withService(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-service-'));
  const store = new TranscriptLedgerStore(root, {
    createViewId: () => transcriptViewId('view-1'),
    now: () => TS,
  });
  const ledger = new TranscriptLedgerService(store, { now: () => TS });
  try {
    await run({ ledger, store });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

function tick() {
  return new Promise((resolve) => queueMicrotask(resolve));
}
