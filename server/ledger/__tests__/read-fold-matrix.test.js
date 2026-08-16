import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  BashToolUseMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { TranscriptSearchController } from '../../chats/search/controller.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { ledgerRowsToTranscriptMessages } from '../presentation.ts';
import { frozenConversationDrafts } from '../projection.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { transcriptViewId } from '../contracts.ts';
import { TranscriptViewReader } from '../view-reader.ts';

const AT = '2026-08-16T00:00:00.000Z';
const CHAT_ID = 'fold-matrix-chat';
const VIEW_ID = transcriptViewId('fold-matrix-view');

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
        [4, 'agent-switch', null],
        [5, 'permission-request', null],
        [6, 'permission-cancelled', null],
        [7, 'permission-request', null],
        [8, 'permission-resolved', null],
        [9, 'permission-expired', null],
        [12, 'assistant-message', 'late provider output'],
        [13, 'user-message', 'repeated payload'],
        [14, 'assistant-message', 'repeated payload'],
      ]);

      const conversation = ledger.conversationRows(CHAT_ID);
      expect(conversation.map((row) => [
        row.ordinal,
        conversationalText(row.kind === 'user-input' ? row.detail.message : row.message),
      ])).toEqual([
        [1, 'repeated payload'],
        [2, 'repeated payload'],
        [12, 'late provider output'],
        [13, 'repeated payload'],
        [14, 'repeated payload'],
      ]);
      expect(ledger.conversationMessages(CHAT_ID, new Set([13])).map(conversationalText)).toEqual([
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
        ['agent-switch', null],
        ['provider-row', 'late provider output'],
        ['user-input', 'repeated payload'],
        ['provider-row', 'repeated payload'],
      ]);

      const reader = new TranscriptViewReader(ledger, {
        ensure: async () => ledger.currentView(CHAT_ID),
      });
      const snapshot = await reader.renderingSnapshot(CHAT_ID);
      expect(snapshot.transcriptViewId).toBe(VIEW_ID);
      expect(snapshot.lastOrdinal).toBe(14);
      expect(snapshot.messages.map((message) => message.type)).toEqual(
        rendered.map((entry) => entry.message.type),
      );

      const searchRows = await initializeSearchFold(ledger, rows);
      expect(searchRows.map((row) => [row.ordinal, row.role, row.body])).toEqual([
        [1, 'user', 'repeated payload'],
        [2, 'assistant', 'repeated payload'],
        [12, 'assistant', 'late provider output'],
        [13, 'user', 'repeated payload'],
        [14, 'assistant', 'repeated payload'],
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
        lastOrdinal: 14,
        messages: rendered,
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
      message: 'Native history changed.',
      detail: { action: 'reload-native-history' },
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
  const replaceChat = mock(async () => undefined);
  const controller = new TranscriptSearchController({
    listChatIds: () => [CHAT_ID],
    ledger: {
      currentView: (chatId) => ledger.currentView(chatId),
      currentRows: () => rows,
      subscribe: () => () => undefined,
    },
    service: {
      setResyncHandler: () => undefined,
      enable: async () => undefined,
      replaceChat,
      appendRows: async () => undefined,
      deleteChat: async () => undefined,
      pruneChats: async () => undefined,
      search: async () => ({
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
      }),
      disableAndDelete: async () => undefined,
      close: async () => undefined,
    },
    logger: { warn: () => undefined },
  });
  await controller.initialize(true);
  await controller.close();
  expect(replaceChat).toHaveBeenCalledTimes(1);
  return replaceChat.mock.calls[0][0].rows;
}

function conversationalText(message) {
  return message.type === 'user-message' || message.type === 'assistant-message'
    ? message.content
    : null;
}

function frozenDraftText(row) {
  if (row.kind === 'user-input') return row.detail.message.content;
  if (row.kind === 'provider-row') return row.message.content;
  return null;
}
