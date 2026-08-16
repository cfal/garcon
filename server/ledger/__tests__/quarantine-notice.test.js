import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { TranscriptSearchController } from '../../chats/search/controller.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { frozenConversationDrafts } from '../projection.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { transcriptViewId } from '../contracts.ts';

const AT = '2026-08-16T00:00:00.000Z';
const CHAT_ID = 'quarantine-fold-chat';
const VIEW_ID = transcriptViewId('quarantine-fold-view');
const QUARANTINE_DETAIL = {
  type: 'carryover-migration-quarantine',
  artifactId: 'artifact-1',
  errorCode: 'CARRYOVER_PARSE_FAILED',
};

describe('carryover migration quarantine notice', () => {
  it('[TLV5-ADOPT.05-CORE-MATRIX-01] preserves only the quarantine notice in the frozen projection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-quarantine-fold-'));
    const store = new TranscriptLedgerStore(root, {
      createViewId: () => VIEW_ID,
      now: () => AT,
    });
    const ledger = new TranscriptLedgerService(store, { now: () => AT });
    try {
      ledger.initializeChat(CHAT_ID);
      const rows = store.append(CHAT_ID, VIEW_ID, fixtureDrafts());

      expect(frozenConversationDrafts(rows).map(frozenRowOracle)).toEqual([
        ['user-input', 'before quarantine', null],
        [
          'notice',
          'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
          QUARANTINE_DETAIL,
        ],
        ['provider-row', 'after quarantine', null],
      ]);

      expect(ledger.conversationMessages(CHAT_ID).map((message) => message.content)).toEqual([
        'before quarantine',
        'after quarantine',
      ]);

      const searchRows = await collectSearchRows(ledger, rows);
      expect(searchRows.map((row) => [row.ordinal, row.role, row.body])).toEqual([
        [1, 'user', 'before quarantine'],
        [4, 'assistant', 'after quarantine'],
      ]);

      const metadataUpdates = [];
      const fanout = createTranscriptEventFanout({
        chatExists: () => true,
        schedule: (_chatId, task) => task(),
        broadcast: () => undefined,
        updateMetadata: (_chatId, messages) => metadataUpdates.push(...messages),
        replaceMetadata: () => undefined,
        resendCandidates: () => [],
      });
      fanout({ type: 'rows', chatId: CHAT_ID, viewId: VIEW_ID, rows });

      expect(metadataUpdates.map((message) => message.content)).toEqual([
        'before quarantine',
        'after quarantine',
      ]);
      expect(metadataUpdates.at(-1)?.content).toBe('after quarantine');
    } finally {
      ledger.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function fixtureDrafts() {
  return [
    {
      kind: 'user-input',
      at: AT,
      providerMeta: null,
      detail: {
        clientMessageId: 'client-1',
        message: new UserMessage(AT, 'before quarantine'),
        attachments: [],
        steer: false,
      },
    },
    {
      kind: 'notice',
      at: AT,
      providerMeta: null,
      message: 'Native history changed.',
      detail: { action: 'reload-native-history' },
    },
    {
      kind: 'notice',
      at: AT,
      providerMeta: null,
      message: 'Some earlier chat history could not be migrated. Quarantine reference: artifact-1.',
      detail: QUARANTINE_DETAIL,
    },
    {
      kind: 'provider-row',
      at: AT,
      providerMeta: null,
      message: new AssistantMessage(AT, 'after quarantine'),
    },
  ];
}

function frozenRowOracle(row) {
  if (row.kind === 'user-input') return [row.kind, row.detail.message.content, null];
  if (row.kind === 'provider-row') return [row.kind, row.message.content, null];
  return [row.kind, row.message, row.detail];
}

async function collectSearchRows(ledger, rows) {
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
