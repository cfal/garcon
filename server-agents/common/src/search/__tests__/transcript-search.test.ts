import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchTranscriptIndexV1 } from '../query.js';
import {
  appendChatRows,
  closeSearchDatabase,
  getChatState,
  markChatFailed,
  openSearchDatabase,
  replaceChatRows,
} from '../schema.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function database() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-search-ledger-'));
  roots.push(root);
  return openSearchDatabase(path.join(root, 'index.sqlite'));
}

const query = {
  version: 1 as const,
  clauses: [{
    kind: 'all-words' as const,
    tokens: [{ text: 'needle', normalized: 'needle', match: 'prefix' as const }],
  }],
};

function row(ordinal: number, body: string) {
  return { ordinal, role: 'assistant' as const, timestamp: null, body };
}

describe('ledger-backed transcript search index', () => {
  it('indexes and searches rows under their transcript view', async () => {
    const opened = await database();
    replaceChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      throughOrdinal: 2,
      rows: [row(2, 'a useful needle')],
    });

    const result = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1', throughOrdinal: 2 }],
    });

    expect(result.results).toEqual([expect.objectContaining({
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      snippets: [expect.objectContaining({ ordinal: 2 })],
    })]);
    expect(result.index).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    closeSearchDatabase(opened.db);
  });

  it('appends only the committed suffix and detects gaps', async () => {
    const opened = await database();
    replaceChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      throughOrdinal: 2,
      rows: [],
    });
    appendChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      expectedAfterOrdinal: 2,
      throughOrdinal: 3,
      rows: [row(3, 'needle')],
    });

    expect(() => appendChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      expectedAfterOrdinal: 4,
      throughOrdinal: 5,
      rows: [row(5, 'later')],
    })).toThrow('SEARCH_INDEX_GAP');
    closeSearchDatabase(opened.db);
  });

  it('deletes replaced-view entries atomically', async () => {
    const opened = await database();
    replaceChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      throughOrdinal: 1,
      rows: [row(1, 'old needle')],
    });
    replaceChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-2',
      throughOrdinal: 1,
      rows: [row(1, 'replacement')],
    });

    const old = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1', throughOrdinal: 1 }],
    });
    expect(old.results).toEqual([]);
    expect(opened.db.query('SELECT COUNT(*) AS count FROM search_chunks').get()).toEqual({ count: 1 });
    closeSearchDatabase(opened.db);
  });

  it('[TLV5-SEARCH.05-CORE-UNIT-01] qualifies index health by current view and frontier', async () => {
    const opened = await database();
    replaceChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      throughOrdinal: 2,
      rows: [row(2, 'needle')],
    });

    const staleFrontier = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1', throughOrdinal: 3 }],
    });
    expect(staleFrontier.index).toEqual({
      indexedChatCount: 0,
      pendingChatCount: 1,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });

    const current = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1', throughOrdinal: 2 }],
    });
    expect(current.index).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });

    const oldView = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-old', throughOrdinal: 2 }],
    });
    expect(oldView.index).toEqual({
      indexedChatCount: 0,
      pendingChatCount: 1,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    closeSearchDatabase(opened.db);
  });

  it('[TLV5-SEARCH.05-ZERO-ROW-CORE-UNIT-01] indexes valid empty views and later searchable rows', async () => {
    const opened = await database();
    replaceChatRows(opened.db, {
      chatId: 'chat-empty',
      transcriptViewId: 'view-empty',
      throughOrdinal: 3,
      rows: [],
    });

    const empty = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-empty', transcriptViewId: 'view-empty', throughOrdinal: 3 }],
    });
    expect(empty).toEqual({
      results: [],
      index: {
        indexedChatCount: 1,
        pendingChatCount: 0,
        failedChatCount: 0,
        unsupportedChatCount: 0,
      },
    });

    appendChatRows(opened.db, {
      chatId: 'chat-empty',
      transcriptViewId: 'view-empty',
      expectedAfterOrdinal: 3,
      throughOrdinal: 4,
      rows: [row(4, 'later needle')],
    });
    const appended = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-empty', transcriptViewId: 'view-empty', throughOrdinal: 4 }],
    });
    expect(appended.results).toEqual([
      expect.objectContaining({ chatId: 'chat-empty', transcriptViewId: 'view-empty' }),
    ]);
    expect(appended.index).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    closeSearchDatabase(opened.db);
  });

  it('records bounded failure state without retaining chunks from an old view', async () => {
    const opened = await database();
    replaceChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      throughOrdinal: 2,
      rows: [row(2, 'needle')],
    });

    markChatFailed(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      errorCode: 'SEARCH_WRITE_REJECTED',
    });
    expect(getChatState(opened.db, 'chat-1')).toEqual({
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      indexedThrough: 2,
      status: 'failed',
    });
    expect(opened.db.query(`
      SELECT last_error_code AS errorCode FROM search_chat_state WHERE chat_id = ?
    `).get('chat-1')).toEqual({ errorCode: 'SEARCH_WRITE_REJECTED' });
    const failed = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1', throughOrdinal: 2 }],
    });
    expect(failed.index).toEqual({
      indexedChatCount: 0,
      pendingChatCount: 0,
      failedChatCount: 1,
      unsupportedChatCount: 0,
    });

    appendChatRows(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      expectedAfterOrdinal: 2,
      throughOrdinal: 2,
      rows: [],
    });
    const repaired = searchTranscriptIndexV1(opened.db, {
      query,
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1', throughOrdinal: 2 }],
    });
    expect(repaired.results).toEqual([
      expect.objectContaining({ chatId: 'chat-1', transcriptViewId: 'view-1' }),
    ]);
    expect(repaired.index).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    expect(opened.db.query(`
      SELECT last_error_code AS errorCode FROM search_chat_state WHERE chat_id = ?
    `).get('chat-1')).toEqual({ errorCode: null });
    expect(() => markChatFailed(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-1',
      errorCode: 'provider error text',
    })).toThrow('INVALID_SEARCH_ERROR_CODE');

    markChatFailed(opened.db, {
      chatId: 'chat-1',
      transcriptViewId: 'view-2',
      errorCode: 'SEARCH_VIEW_REJECTED',
    });
    expect(getChatState(opened.db, 'chat-1')).toEqual({
      chatId: 'chat-1',
      transcriptViewId: 'view-2',
      indexedThrough: 0,
      status: 'failed',
    });
    expect(opened.db.query('SELECT COUNT(*) AS count FROM search_chunks').get()).toEqual({ count: 0 });
    closeSearchDatabase(opened.db);
  });
});
