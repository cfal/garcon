import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptHistoryUnavailableError } from '../../chats/errors.ts';
import { transcriptViewId } from '../contracts.ts';
import { LedgerFencedError } from '../errors.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { TranscriptViewReader } from '../view-reader.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptViewReader', () => {
  it('pages visible messages by durable ordinal across hidden lifecycle rows', async () => {
    await withReader(async ({ ledger, reader, viewId }) => {
      const lease = ledger.openProducer('chat-1', 'test');
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId,
        message: new UserMessage(TS, 'one'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      lease.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      });
      lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(TS, 'two') }] });
      ledger.beginRun('chat-1', 'run-1');
      lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });

      const newest = await reader.page('chat-1', 1);
      expect(newest).toMatchObject({
        transcriptViewId: 'view-1',
        lastOrdinal: 4,
        pageOldestOrdinal: 3,
        hasMore: true,
      });
      expect(newest.messages.map((entry) => [entry.ordinal, entry.message.content]))
        .toEqual([[3, 'two']]);

      const older = await reader.page('chat-1', 1, newest.pageOldestOrdinal);
      expect(older.messages.map((entry) => [entry.ordinal, entry.message.content]))
        .toEqual([[1, 'one']]);
      expect(older.hasMore).toBe(false);
    });
  });

  it('replays the complete committed ordinal range even when no row renders', async () => {
    await withReader(async ({ ledger, reader, viewId }) => {
      const lease = ledger.openProducer('chat-1', 'test');
      lease.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      });

      await expect(reader.replay('chat-1', viewId, 0)).resolves.toEqual({
        transcriptViewId: 'view-1',
        firstOrdinal: 1,
        lastOrdinal: 1,
        messages: [],
      });
    });
  });

  it('captures the rendering fold as a self-contained view snapshot', async () => {
    await withReader(async ({ ledger, reader, viewId }) => {
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId,
        message: new UserMessage(TS, 'prompt'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      const producer = ledger.openProducer('chat-1', 'test');
      producer.sink.publish({
        type: 'session',
        session: { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null },
      });
      producer.sink.publish({
        type: 'rows',
        rows: [{ message: new AssistantMessage(TS, 'answer') }],
      });

      const snapshot = await reader.renderingSnapshot('chat-1');

      expect(snapshot).toMatchObject({
        transcriptViewId: viewId,
        lastOrdinal: 3,
      });
      expect(snapshot.messages.map((message) => message.content)).toEqual(['prompt', 'answer']);
    });
  });

  it('checks native activity for a newest-page open but not older paging', async () => {
    await withReader(async ({ reader, nativeActivity }) => {
      await reader.page('chat-1', 20);
      await reader.page('chat-1', 20, 1);

      expect(nativeActivity.check).toHaveBeenCalledTimes(1);
      expect(nativeActivity.check).toHaveBeenCalledWith(
        'chat-1',
        expect.any(AbortSignal),
      );
    });
  });

  it('presents a fenced ledger as typed degraded history', async () => {
    await withReader(async ({ ledger }) => {
      const reader = new TranscriptViewReader(ledger, {
        ensure: async () => {
          throw new LedgerFencedError('chat-1');
        },
      });
      let failure;
      try {
        await reader.page('chat-1', 20);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(TranscriptHistoryUnavailableError);
      expect(failure).toMatchObject({
        name: 'DomainError',
        code: 'TRANSCRIPT_UNAVAILABLE',
        historyState: {
          kind: 'degraded',
          errorCode: 'LEDGER_FENCED',
          retryable: true,
        },
      });
    });
  });
});

async function withReader(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-view-'));
  const viewId = transcriptViewId('view-1');
  const store = new TranscriptLedgerStore(root, { createViewId: () => viewId, now: () => TS });
  const ledger = new TranscriptLedgerService(store, { now: () => TS });
  ledger.initializeChat('chat-1');
  const nativeActivity = { check: mock(async () => false) };
  const reader = new TranscriptViewReader(ledger, {
    ensure: async () => ledger.currentView('chat-1'),
  }, nativeActivity);
  try {
    await run({ ledger, nativeActivity, reader, viewId });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
