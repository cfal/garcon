import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  BashToolUseMessage,
  CliRowMessage,
  ErrorMessage,
  TranscriptNoticeMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { TranscriptSearchController } from '../../chats/search/controller.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { foldRowsForExport } from '../export-fold.ts';
import { ledgerRowsToTranscriptMessages } from '../presentation.ts';
import { frozenConversationDrafts } from '../projection.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { transcriptViewId } from '../contracts.ts';
import { TranscriptViewReader } from '../view-reader.ts';

const AT = '2026-08-16T00:00:00.000Z';
const CHAT_ROW_AT = '2026-08-16T00:01:00.000Z';
const CHAT_ID = 'fold-matrix-chat';
const VIEW_ID = transcriptViewId('fold-matrix-view');
const QUARANTINE_DETAIL = {
  type: 'carryover-migration-quarantine',
  artifactId: 'artifact-1',
  errorCode: 'CARRYOVER_PARSE_FAILED',
};
const QUARANTINE_NOTICE =
  'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.';

describe('transcript ledger read-fold matrix', () => {
  it('[TLV5-L01.02-CORE-MATRIX-01] projects every row kind through its declared consumer fold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-fold-matrix-'));
    const store = new TranscriptLedgerStore(root, {
      createViewId: () => VIEW_ID,
      now: () => AT,
    });
    const ledger = new TranscriptLedgerService(store, { now: () => AT });
    try {
      ledger.initializeChat(CHAT_ID);
      const rows = store.append(CHAT_ID, VIEW_ID, allRowKindDrafts());

      const rendered = ledgerRowsToTranscriptMessages(rows);
      expect(rendered.map((entry) => [
        entry.ordinal,
        entry.message.type,
        conversationalText(entry.message),
      ])).toEqual([
        [1, 'user-message', 'repeated payload'],
        [2, 'assistant-message', 'repeated payload'],
        [3, 'transcript-notice', null],
        [4, 'transcript-notice', null],
        [5, 'agent-switch', null],
        [6, 'permission-request', null],
        [7, 'permission-cancelled', null],
        [8, 'permission-request', null],
        [9, 'permission-resolved', null],
        [10, 'permission-expired', null],
        [13, 'assistant-message', 'late provider output'],
        [14, 'user-message', 'repeated payload'],
        [15, 'assistant-message', 'repeated payload'],
      ]);
      expect(rendered.filter((entry) => entry.message.type === 'transcript-notice')).toEqual([
        {
          ordinal: 3,
          message: new TranscriptNoticeMessage(
            AT,
            'Ordinary durable notice.',
          ),
        },
        {
          ordinal: 4,
          message: new TranscriptNoticeMessage(
            AT,
            QUARANTINE_NOTICE,
            QUARANTINE_DETAIL,
          ),
        },
      ]);

      const conversation = ledger.conversationRows(CHAT_ID);
      expect(conversation.map((row) => [
        row.ordinal,
        conversationalText(row.kind === 'user-input' ? row.detail.message : row.message),
      ])).toEqual([
        [1, 'repeated payload'],
        [2, 'repeated payload'],
        [13, 'late provider output'],
        [14, 'repeated payload'],
        [15, 'repeated payload'],
      ]);
      expect(ledger.conversationMessages(CHAT_ID, new Set([14])).map(conversationalText)).toEqual([
        'repeated payload',
        'repeated payload',
        'late provider output',
        'repeated payload',
      ]);

      expect(frozenConversationDrafts(rows).map((row) => [
        row.kind,
        frozenDraftText(row),
      ])).toEqual([
        ['user-input', 'repeated payload'],
        ['provider-row', 'repeated payload'],
        ['notice', QUARANTINE_NOTICE],
        ['agent-switch', null],
        ['provider-row', 'late provider output'],
        ['user-input', 'repeated payload'],
        ['provider-row', 'repeated payload'],
      ]);
      expect(frozenConversationDrafts(rows).filter((row) => row.kind === 'notice')).toEqual([{
        kind: 'notice',
        at: AT,
        message: QUARANTINE_NOTICE,
        detail: QUARANTINE_DETAIL,
        providerMeta: null,
      }]);

      const reader = new TranscriptViewReader(ledger, {
        ensure: async () => ledger.currentView(CHAT_ID),
      });
      const snapshot = await reader.renderingSnapshot(CHAT_ID);
      expect(snapshot.transcriptViewId).toBe(VIEW_ID);
      expect(snapshot.lastOrdinal).toBe(15);
      expect(snapshot.messages).toEqual(rendered.map((entry) => entry.message));

      const searchRows = await initializeSearchFold(ledger, rows);
      expect(searchRows.map((row) => [row.ordinal, row.role, row.body])).toEqual([
        [1, 'user', 'repeated payload'],
        [2, 'assistant', 'repeated payload'],
        [13, 'assistant', 'late provider output'],
        [14, 'user', 'repeated payload'],
        [15, 'assistant', 'repeated payload'],
      ]);

      const metadataUpdates = [];
      const broadcasts = [];
      const fanout = createTranscriptEventFanout({
        chatExists: () => true,
        schedule: (_chatId, task) => task(),
        broadcast: (message) => broadcasts.push(message),
        updateMetadata: (_chatId, messages) => metadataUpdates.push(...messages),
        replaceMetadata: () => undefined,
        resendCandidates: () => [],
      });
      fanout({ type: 'rows', chatId: CHAT_ID, viewId: VIEW_ID, rows });

      expect(metadataUpdates.map(conversationalText)).toEqual([
        'repeated payload',
        'repeated payload',
        'late provider output',
        'repeated payload',
        'repeated payload',
      ]);
      expect(broadcasts).toEqual([expect.objectContaining({
        transcriptViewId: VIEW_ID,
        firstOrdinal: 1,
        lastOrdinal: 15,
        messages: rendered,
      })]);
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[TLV5-L01.02-CORE-EXPORT-01] projects every durable row kind through the user-export fold', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-ledger-export-matrix-'));
    const store = new TranscriptLedgerStore(root, {
      createViewId: () => VIEW_ID,
      now: () => AT,
    });
    const ledger = new TranscriptLedgerService(store, { now: () => AT });
    try {
      ledger.initializeChat(CHAT_ID);
      const entries = foldRowsForExport(store.append(CHAT_ID, VIEW_ID, allRowKindDrafts()));

      expect(entries.map((entry) => [entry.ordinal, entry.kind, entry.category])).toEqual([
        [1, 'message', 'conversation'],
        [2, 'message', 'conversation'],
        [3, 'message', 'diagnostics'],
        [4, 'message', 'conversation'],
        [5, 'message', 'handoffs'],
        [6, 'message', 'permissions'],
        [7, 'message', 'permissions'],
        [8, 'message', 'permissions'],
        [9, 'message', 'permissions'],
        [10, 'message', 'permissions'],
        [12, 'run-ended', 'diagnostics'],
        [13, 'message', 'conversation'],
        [14, 'message', 'conversation'],
        [15, 'message', 'conversation'],
      ]);
      expect(entries.some((entry) => entry.ordinal === 11)).toBe(false);
      expect(JSON.stringify(entries)).not.toContain('providerOccurrence');
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[TLV5-CHAT-ROW.03-READ-FOLDS-CORE-UNIT-01] keeps every CLI row style presentation-only across ledger folds', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-chat-row-fold-matrix-'));
    const store = new TranscriptLedgerStore(root, {
      createViewId: () => VIEW_ID,
      now: () => AT,
    });
    const ledger = new TranscriptLedgerService(store, { now: () => CHAT_ROW_AT });
    try {
      const view = ledger.initializeChat(CHAT_ID);
      ledger.appendInputAndCompose({
        chatId: CHAT_ID,
        viewId: view.viewId,
        message: new UserMessage(AT, 'pending user input'),
        attachments: [],
        clientMessageId: 'pending-input',
        steer: false,
      });
      const info = ledger.appendChatRow({
        chatId: CHAT_ID,
        viewId: view.viewId,
        clientMessageId: 'chat-row-info',
        presentation: { style: 'info' },
        format: 'plain',
        title: 'Consultation checkpoint',
        content: 'presentation information',
      });
      const notice = ledger.appendChatRow({
        chatId: CHAT_ID,
        viewId: view.viewId,
        clientMessageId: 'chat-row-notice',
        presentation: { style: 'notice' },
        format: 'markdown',
        title: 'Presentation checkpoint',
        content: 'presentation notice',
      });
      const error = ledger.appendChatRow({
        chatId: CHAT_ID,
        viewId: view.viewId,
        clientMessageId: 'chat-row-error',
        presentation: { style: 'error' },
        format: 'plain',
        title: 'Failure checkpoint',
        content: 'chat row error',
      });
      const producer = ledger.openProducer(CHAT_ID, 'test');
      producer.sink.publish({
        type: 'rows',
        rows: [{ message: new ErrorMessage(AT, 'provider error') }],
      });
      const rows = ledger.currentRows(CHAT_ID);

      expect(ledger.nativeActivityState(CHAT_ID).providerWatermark).toEqual({
        ordinal: 5,
        at: AT,
      });

      expect(ledgerRowsToTranscriptMessages(rows).map(({ ordinal, message }) => [
        ordinal,
        message.type,
        'content' in message ? message.content : null,
      ])).toEqual([
        [1, 'user-message', 'pending user input'],
        [2, 'cli-row', 'presentation information'],
        [3, 'cli-row', 'presentation notice'],
        [4, 'cli-row', 'chat row error'],
        [5, 'error', 'provider error'],
      ]);
      expect(ledger.conversationMessages(CHAT_ID)).toEqual([
        expect.objectContaining({ type: 'user-message', content: 'pending user input' }),
      ]);
      expect(ledger.resendCandidates(CHAT_ID).map(({ content }) => content)).toEqual([
        'pending user input',
      ]);

      expect(frozenConversationDrafts(rows)).toEqual([
        expect.objectContaining({ kind: 'user-input' }),
      ]);

      const searchRows = await initializeSearchFold(ledger, rows);
      expect(searchRows).toEqual([
        { ordinal: 1, role: 'user', body: 'pending user input', timestamp: AT },
      ]);

      const metadataUpdates = [];
      const broadcasts = [];
      const fanout = createTranscriptEventFanout({
        chatExists: () => true,
        schedule: (_chatId, task) => task(),
        broadcast: (message) => broadcasts.push(message),
        updateMetadata: (_chatId, messages) => metadataUpdates.push(...messages),
        replaceMetadata: () => undefined,
        resendCandidates: () => [],
      });
      fanout({
        type: 'rows',
        chatId: CHAT_ID,
        viewId: VIEW_ID,
        rows: [info.row, notice.row, error.row, rows[4]],
      });

      expect(metadataUpdates).toEqual([]);
      expect(broadcasts).toEqual([expect.objectContaining({
        firstOrdinal: 2,
        lastOrdinal: 5,
        messages: [
          {
            ordinal: 2,
            message: new CliRowMessage(
              CHAT_ROW_AT,
              'presentation information',
              { style: 'info' },
              'plain',
              'Consultation checkpoint',
            ),
          },
          {
            ordinal: 3,
            message: new CliRowMessage(
              CHAT_ROW_AT,
              'presentation notice',
              { style: 'notice' },
              'markdown',
              'Presentation checkpoint',
            ),
          },
          {
            ordinal: 4,
            message: new CliRowMessage(
              CHAT_ROW_AT,
              'chat row error',
              { style: 'error' },
              'plain',
              'Failure checkpoint',
            ),
          },
          { ordinal: 5, message: new ErrorMessage(AT, 'provider error') },
        ],
      })]);
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function allRowKindDrafts() {
  return [
    {
      kind: 'user-input',
      at: AT,
      providerMeta: null,
      detail: {
        clientMessageId: 'client-message-1',
        message: new UserMessage(AT, 'repeated payload'),
        attachments: [],
        steer: false,
      },
    },
    {
      kind: 'provider-row',
      at: AT,
      providerMeta: { providerOccurrence: 'assistant-1' },
      message: new AssistantMessage(AT, 'repeated payload'),
    },
    {
      kind: 'notice',
      at: AT,
      providerMeta: null,
      message: 'Ordinary durable notice.',
      detail: { type: 'ordinary-notice' },
    },
    {
      kind: 'notice',
      at: AT,
      providerMeta: null,
      message: QUARANTINE_NOTICE,
      detail: QUARANTINE_DETAIL,
    },
    {
      kind: 'agent-switch',
      at: AT,
      providerMeta: null,
      detail: {
        fromAgentId: 'claude',
        toAgentId: 'codex',
        fromModel: 'haiku',
        toModel: 'gpt-5.4',
      },
    },
    permissionDraft('requested', 'first-occurrence'),
    permissionDraft('cancelled', 'first-occurrence'),
    permissionDraft('requested', 'second-occurrence'),
    permissionDraft('resolved', 'second-occurrence'),
    permissionDraft('expired', 'third-occurrence'),
    {
      kind: 'session',
      at: AT,
      providerMeta: null,
      detail: {
        agentSessionId: 'native-session',
        nativeSession: null,
        nativeSeedReceipt: null,
      },
    },
    {
      kind: 'run-ended',
      at: AT,
      providerMeta: null,
      outcome: 'finished',
      origin: 'provider',
    },
    {
      kind: 'provider-row',
      at: AT,
      providerMeta: { providerOccurrence: 'late-assistant' },
      message: new AssistantMessage(AT, 'late provider output'),
    },
    {
      kind: 'user-input',
      at: AT,
      providerMeta: null,
      detail: {
        clientMessageId: 'client-message-2',
        message: new UserMessage(AT, 'repeated payload'),
        attachments: [],
        steer: false,
      },
    },
    {
      kind: 'provider-row',
      at: AT,
      providerMeta: { providerOccurrence: 'assistant-2' },
      message: new AssistantMessage(AT, 'repeated payload'),
    },
  ];
}

function permissionDraft(kind, permissionOccurrenceId) {
  const common = { kind, permissionOccurrenceId };
  if (kind === 'requested') {
    return {
      kind: 'permission-requested',
      at: AT,
      providerMeta: null,
      lifecycle: {
        ...common,
        requestedTool: new BashToolUseMessage(AT, `tool-${permissionOccurrenceId}`, 'pwd'),
        options: [],
      },
    };
  }
  if (kind === 'resolved') {
    return {
      kind: 'permission-resolved',
      at: AT,
      providerMeta: null,
      lifecycle: { ...common, decision: { allow: true, alwaysAllow: false } },
    };
  }
  if (kind === 'cancelled') {
    return {
      kind: 'permission-cancelled',
      at: AT,
      providerMeta: null,
      lifecycle: { ...common, reason: 'superseded' },
    };
  }
  return {
    kind: 'permission-expired',
    at: AT,
    providerMeta: null,
    lifecycle: common,
  };
}

async function initializeSearchFold(ledger, rows) {
  let resolveSyncStarted;
  const syncStarted = new Promise((resolve) => { resolveSyncStarted = resolve; });
  const syncChat = mock(async (request) => {
    resolveSyncStarted();
    const frames = [];
    for await (const frame of request.source(request.expectedAfterOrdinal)) frames.push(frame);
    return frames.flatMap((frame) => frame.rows);
  });
  const controller = new TranscriptSearchController({
    listChatIds: () => [CHAT_ID],
    ledger: {
      currentView: (chatId) => ledger.currentView(chatId),
      highWatermark: () => ({ viewId: VIEW_ID, ordinal: rows.at(-1)?.ordinal ?? 0 }),
      replayRows: (_chatId, _viewId, afterOrdinal, throughOrdinal, limit) => rows
        .filter((row) => row.ordinal > afterOrdinal && row.ordinal <= throughOrdinal)
        .slice(0, limit),
      subscribe: () => () => undefined,
    },
    service: {
      setResyncHandler: () => undefined,
      enable: async () => undefined,
      chatStates: async () => [],
      beginResync: () => ({
        chatSettled: () => undefined,
        complete: () => undefined,
        fail: () => undefined,
      }),
      recordResyncFailure: () => undefined,
      syncChat,
      markChatUnavailable: async () => undefined,
      deleteChat: async () => undefined,
      search: async () => ({
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
      }),
      status: () => ({
        version: 1,
        phase: 'ready',
        chats: { indexed: 0, pending: 0, failed: 0 },
        queuedJobs: 0,
        resync: null,
        backlogRows: 0,
        activeChat: null,
        lastErrorCode: null,
        updatedAt: AT,
      }),
      queryStats: () => ({
        served: 0,
        timedOut: 0,
        rejectedBusy: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
      }),
      onStatusChanged: () => () => undefined,
      disableAndDelete: async () => undefined,
      close: async () => undefined,
    },
    logger: { warn: () => undefined, info: () => undefined },
  });
  await controller.initialize(true);
  await syncStarted;
  await controller.close();
  expect(syncChat).toHaveBeenCalledTimes(1);
  return await syncChat.mock.results[0].value;
}

function conversationalText(message) {
  return message.type === 'user-message' || message.type === 'assistant-message'
    ? message.content
    : null;
}

function frozenDraftText(row) {
  if (row.kind === 'user-input') return row.detail.message.content;
  if (row.kind === 'provider-row') return row.message.content;
  if (row.kind === 'notice') return row.message;
  return null;
}
