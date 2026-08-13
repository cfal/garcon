import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchTranscriptIndexV1 } from '../query.js';
import {
  appendChatRows,
  closeSearchDatabase,
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
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1' }],
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
      allowedChats: [{ chatId: 'chat-1', transcriptViewId: 'view-1' }],
    });
    expect(old.results).toEqual([]);
    expect(opened.db.query('SELECT COUNT(*) AS count FROM search_chunks').get()).toEqual({ count: 1 });
    closeSearchDatabase(opened.db);
  });
});
