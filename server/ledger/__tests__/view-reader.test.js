import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptHistoryUnavailableError } from '../../chats/errors.ts';
import { transcriptViewId } from '../contracts.ts';
import { LedgerFencedError, StaleTranscriptViewError } from '../errors.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { TranscriptViewReader } from '../view-reader.ts';

const TS = '2026-08-12T00:00:00.000Z';

describe('TranscriptViewReader', () => {
  it('[TLV5-PAGE.08-SERVER-UNIT-01] presents exactly one bounded raw page with its raw continuation', async () => {
    const pageCalls = [];
    const rawRows = Array.from({ length: 50 }, (_, index) => {
      const ordinal = 451 + index;
      if (ordinal === 475) {
        return {
          viewId: transcriptViewId('view-1'),
          ordinal,
          kind: 'provider-row',
          at: TS,
          providerMeta: null,
          message: new AssistantMessage(TS, 'only visible row'),
        };
      }
      return {
        viewId: transcriptViewId('view-1'),
        ordinal,
        kind: 'session',
        at: TS,
        providerMeta: null,
        detail: {
          agentSessionId: `session-${ordinal}`,
          nativeSession: null,
          nativeSeedReceipt: null,
        },
      };
    });
    const reader = new TranscriptViewReader({
      highWatermark: () => ({ viewId: transcriptViewId('view-1'), ordinal: 500 }),
      page(chatId, viewId, limit, beforeOrdinal) {
        pageCalls.push({ chatId, viewId, limit, beforeOrdinal });
        if (pageCalls.length > 1) throw new Error('One HTTP page must perform one raw scan');
        return { viewId, rows: rawRows, nextBefore: 451 };
      },
    }, {
      ensure: async () => ({
        viewId: transcriptViewId('view-1'),
        status: 'current',
        createdAt: TS,
        contentStartOrdinal: 1,
      }),
    });

    await expect(reader.page('chat-1', 50, 999, 'view-1')).resolves.toEqual({
      transcriptViewId: 'view-1',
      messages: [{
        ordinal: 475,
        message: new AssistantMessage(TS, 'only visible row'),
      }],
      lastOrdinal: 500,
      pageOldestOrdinal: 475,
      pageNewestOrdinal: 500,
      nextBeforeOrdinal: 451,
      hasMore: true,
    });
    expect(pageCalls).toEqual([{
      chatId: 'chat-1',
      viewId: 'view-1',
      limit: 50,
      beforeOrdinal: 501,
    }]);
  });

  it('[TLV5-PAGE.09-SERVER-UNIT-01] advances an all-hidden raw page without scanning for a visible row', async () => {
    const pageCalls = [];
    const reader = new TranscriptViewReader({
      highWatermark: () => ({ viewId: transcriptViewId('view-1'), ordinal: 250 }),
      page(chatId, viewId, limit, beforeOrdinal) {
        pageCalls.push({ chatId, viewId, limit, beforeOrdinal });
        if (pageCalls.length > 1) throw new Error('Hidden rows must not trigger another server scan');
        return {
          viewId,
          rows: Array.from({ length: 50 }, (_, index) => ({
            viewId,
            ordinal: 201 + index,
            kind: 'session',
            at: TS,
            providerMeta: null,
            detail: {
              agentSessionId: `session-${201 + index}`,
              nativeSession: null,
              nativeSeedReceipt: null,
            },
          })),
          nextBefore: 201,
        };
      },
    }, {
      ensure: async () => ({
        viewId: transcriptViewId('view-1'),
        status: 'current',
        createdAt: TS,
        contentStartOrdinal: 1,
      }),
    });

    await expect(reader.page('chat-1', 50, 251, 'view-1')).resolves.toEqual({
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 250,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 250,
      nextBeforeOrdinal: 201,
      hasMore: true,
    });
    expect(pageCalls).toHaveLength(1);
  });

  it('[TLV5-PAGE.08-SERVER-UNIT-02] queries the empty raw interval at ordinal one exactly once', async () => {
    const pageCalls = [];
    const reader = new TranscriptViewReader({
      highWatermark: () => ({ viewId: transcriptViewId('view-1'), ordinal: 250 }),
      page(chatId, viewId, limit, beforeOrdinal) {
        pageCalls.push({ chatId, viewId, limit, beforeOrdinal });
        return { viewId, rows: [], nextBefore: null };
      },
    }, {
      ensure: async () => ({
        viewId: transcriptViewId('view-1'),
        status: 'current',
        createdAt: TS,
        contentStartOrdinal: 1,
      }),
    });

    await expect(reader.page('chat-1', 50, 1, 'view-1')).resolves.toEqual({
      transcriptViewId: 'view-1',
      messages: [],
      lastOrdinal: 250,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 0,
      nextBeforeOrdinal: null,
      hasMore: false,
    });
    expect(pageCalls).toEqual([{
      chatId: 'chat-1',
      viewId: 'view-1',
      limit: 50,
      beforeOrdinal: 1,
    }]);
  });

  it('[TLV5-L01.01-CORE-UNIT-01] pages visible messages by durable ordinal across hidden lifecycle rows', async () => {
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

  it('rejects a stale expected view before reading its watermark or rows', async () => {
    const currentView = {
      viewId: transcriptViewId('view-2'),
      status: 'current',
      createdAt: TS,
      contentStartOrdinal: 1,
    };
    const ledger = {
      highWatermark() {
        throw new Error('stale pages must not read a watermark');
      },
      page() {
        throw new Error('stale pages must not scan rows');
      },
    };
    const reader = new TranscriptViewReader(ledger, {
      ensure: async () => currentView,
    });

    await expect(reader.page('chat-1', 20, 10, 'view-1'))
      .rejects.toBeInstanceOf(StaleTranscriptViewError);
  });

  it('[TLV5-REPLAY.04-CORE-UNIT-01] replays the complete committed ordinal range even when no row renders', async () => {
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
        nextAfterOrdinal: 1,
        throughOrdinal: 1,
        hasMore: false,
      });
    });
  });

  it('rejects a client-supplied replay watermark beyond the committed view', async () => {
    await withReader(async ({ ledger, reader, viewId }) => {
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId,
        message: new UserMessage(TS, 'one'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });

      await expect(reader.replay('chat-1', viewId, 0, 2))
        .rejects.toThrow('watermark');
      await expect(reader.replay('chat-1', viewId, 0, 1)).resolves.toMatchObject({
        transcriptViewId: viewId,
        nextAfterOrdinal: 1,
        throughOrdinal: 1,
        hasMore: false,
      });
    });
  });

  it('[TLV5-L08.02-CORE-UNIT-01] rejects a fixed-watermark continuation after the transcript view is replaced', async () => {
    await withReader(async ({ ledger, reader, viewId }) => {
      const producer = ledger.openProducer('chat-1', 'test');
      producer.sink.publish({
        type: 'rows',
        rows: Array.from({ length: 300 }, (_, index) => ({
          message: new AssistantMessage(TS, `old-${index + 1}`),
        })),
      });
      const first = await reader.replay('chat-1', viewId, 0);
      expect(first).toMatchObject({
        transcriptViewId: viewId,
        nextAfterOrdinal: 200,
        throughOrdinal: 300,
        hasMore: true,
      });

      const replacementViewId = transcriptViewId('view-2');
      ledger.closeProducer('chat-1');
      ledger.stageView('chat-1', [{
        kind: 'provider-row',
        at: TS,
        message: new AssistantMessage(TS, 'replacement'),
      }], 1, replacementViewId);
      ledger.replaceCurrentView('chat-1', viewId, replacementViewId);

      await expect(reader.replay(
        'chat-1',
        viewId,
        first.nextAfterOrdinal,
        first.throughOrdinal,
      )).rejects.toBeInstanceOf(StaleTranscriptViewError);
      await expect(reader.replay('chat-1', replacementViewId, 0)).resolves.toMatchObject({
        transcriptViewId: replacementViewId,
        messages: [expect.objectContaining({
          ordinal: 1,
          message: expect.objectContaining({ content: 'replacement' }),
        })],
        nextAfterOrdinal: 1,
        throughOrdinal: 1,
        hasMore: false,
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

  it('rejects a rendering snapshot when adoption races a view replacement', async () => {
    await withReader(async ({ ledger, viewId }) => {
      ledger.appendInputAndCompose({
        chatId: 'chat-1',
        viewId,
        message: new UserMessage(TS, 'old view'),
        attachments: [],
        clientMessageId: 'message-1',
        steer: false,
      });
      const replacementViewId = transcriptViewId('view-2');
      const reader = new TranscriptViewReader(ledger, {
        ensure: async () => {
          const observedView = ledger.currentView('chat-1');
          ledger.stageView('chat-1', [{
            kind: 'provider-row',
            at: TS,
            message: new AssistantMessage(TS, 'replacement view'),
          }], 1, replacementViewId);
          ledger.replaceCurrentView('chat-1', viewId, replacementViewId);
          return observedView;
        },
      });

      await expect(reader.renderingSnapshot('chat-1')).rejects.toMatchObject({
        code: 'SOURCE_REVISION_CHANGED',
        status: 409,
        retryable: true,
      });
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
  const reader = new TranscriptViewReader(ledger, {
    ensure: async () => ledger.currentView('chat-1'),
  });
  try {
    await run({ ledger, reader, viewId });
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}
