import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEARCH_QUERY_MATCH_ROW_LIMIT, searchTranscriptIndexV1 } from '../query.js';
import {
  SEARCH_INGEST_ROW_MAX_BYTES,
  SEARCH_INGEST_TXN_MAX_ROWS,
  SEARCH_TIMESTAMP_MAX_BYTES,
  closeSearchDatabase,
  deleteChatBatch,
  deleteStaleRowsBatch,
  finishChatSync,
  getChatState,
  insertRowsBatch,
  listChatStates,
  markChatFailed,
  observeWalTruncate,
  openSearchDatabase,
  openSearchReadDatabase,
  planChatSync,
  requireExactShadowSet,
  runIdleMaintenance,
  statusCounts,
} from '../schema.js';
import { syntheticRows } from './fixtures.js';

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'search-v9-schema-'));
  dbPath = join(directory, 'index.sqlite');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function openFresh(): Promise<Database> {
  return (await openSearchDatabase(dbPath)).db;
}

function buildChat(
  db: Database,
  chatId: string,
  viewId: string,
  rowCount: number,
  marker?: string,
): void {
  const plan = planChatSync(db, {
    mode: 'replace',
    chatId,
    transcriptViewId: viewId,
    targetThrough: rowCount,
    expectedAfterOrdinal: 0,
  });
  expect(plan.plan).toBe('build');
  for (let offset = 0; offset < rowCount; offset += SEARCH_INGEST_TXN_MAX_ROWS) {
    const count = Math.min(SEARCH_INGEST_TXN_MAX_ROWS, rowCount - offset);
    insertRowsBatch(db, {
      chatId,
      transcriptViewId: viewId,
      rows: syntheticRows({
        seed: 7 + offset,
        count,
        startOrdinal: offset + 1,
        marker,
      }),
      advanceTo: offset + count,
    });
  }
  finishChatSync(db, { chatId, transcriptViewId: viewId });
}

function markerSearch(
  db: Database,
  chatId: string,
  viewId: string,
  throughOrdinal: number,
  marker: string,
) {
  return searchTranscriptIndexV1(db, {
    query: {
      version: 1,
      clauses: [{
        kind: 'all-words',
        tokens: [{ text: marker, normalized: marker, match: 'exact' }],
      }],
    },
    allowedChats: [{ chatId, transcriptViewId: viewId, throughOrdinal }],
  });
}

describe('schema v9', () => {
  test('[TLV5-SEARCH.10-SCHEMA-01] recreates stale and malformed derived files', async () => {
    for (const staleVersion of [7, 8, 3]) {
      rmSync(dbPath, { force: true });
      const stale = new Database(dbPath, { create: true });
      stale.exec(`CREATE TABLE stale_marker(value TEXT); PRAGMA user_version = ${staleVersion}`);
      stale.close();
      const opened = await openSearchDatabase(dbPath);
      expect(opened.recreated).toBe(true);
      expect(opened.db.query('PRAGMA user_version').get()).toEqual({ user_version: 9 });
      expect(opened.db.query(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'stale_marker'",
      ).get()).toEqual({ count: 0 });
      opened.db.close();
    }
  });

  test('[TLV5-SEARCH.10-SCHEMA-03] validates the complete v9 identity', async () => {
    const mutations = [
      (db: Database) => db.exec('DROP TRIGGER search_chunks_ad'),
      (db: Database) => db.exec('CREATE TABLE search_extra(value TEXT) STRICT'),
      (db: Database) => db.exec('CREATE TABLE search_chunks_fts_evil(value TEXT) STRICT'),
      (db: Database) => db.exec('CREATE VIRTUAL TABLE search_extra_fts USING fts5(x)'),
    ];
    for (const mutate of mutations) {
      rmSync(dbPath, { force: true });
      const fresh = await openSearchDatabase(dbPath);
      fresh.db.close();
      const tampered = new Database(dbPath);
      mutate(tampered);
      tampered.close();
      const reopened = await openSearchDatabase(dbPath);
      expect(reopened.recreated).toBe(true);
      reopened.db.close();
    }

    rmSync(dbPath, { force: true });
    const first = await openSearchDatabase(dbPath);
    first.db.close();
    const second = await openSearchDatabase(dbPath);
    expect(second.recreated).toBe(false);
    second.db.close();
  });

  test('[TLV5-SEARCH.10-SCHEMA-04] requires the pinned shadow manifest', () => {
    const exact = new Set([
      'search_chunks_fts_data',
      'search_chunks_fts_idx',
      'search_chunks_fts_config',
    ]);
    expect(() => requireExactShadowSet(exact)).not.toThrow();
    expect(() => requireExactShadowSet(new Set([...exact].slice(1))))
      .toThrow('SEARCH_SCHEMA_INVALID');
    expect(() => requireExactShadowSet(new Set([...exact, 'search_extra_fts_data'])))
      .toThrow('SEARCH_SCHEMA_INVALID');
  });

  test('[TLV5-SEARCH.10-SCHEMA-05] reader TEMP state does not weaken readonly main', async () => {
    const writer = await openFresh();
    closeSearchDatabase(writer);
    const reader = openSearchReadDatabase(dbPath);
    reader.exec(`
      CREATE TEMP TABLE staged_ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
      INSERT INTO staged_ids(id) VALUES ('chat-0001');
    `);
    expect(reader.query('SELECT id FROM staged_ids').all()).toEqual([{ id: 'chat-0001' }]);
    expect(() => reader.exec('CREATE TABLE main.forbidden(value TEXT)')).toThrow();
    reader.close();
  });

  test('[TLV5-SEARCH.06-SCHEMA-01] a covered plan performs zero writes', async () => {
    const db = await openFresh();
    buildChat(db, 'chat-0001', 'view-0001', 40);
    const before = db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value;
    const stamp = db.query<{ updatedAt: string }, []>(
      'SELECT updated_at AS updatedAt FROM search_chat_state',
    ).get();
    const plan = planChatSync(db, {
      mode: 'replace',
      chatId: 'chat-0001',
      transcriptViewId: 'view-0001',
      targetThrough: 40,
      expectedAfterOrdinal: 0,
    });
    expect(plan.plan).toBe('current');
    expect(db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value)
      .toBe(before);
    expect(db.query<{ updatedAt: string }, []>(
      'SELECT updated_at AS updatedAt FROM search_chat_state',
    ).get()).toEqual(stamp);
    db.close();
  });

  test('[TLV5-SEARCH.07-SCHEMA-01] a pending build resumes at its durable frontier', async () => {
    const db = await openFresh();
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-0002', transcriptViewId: 'view-0002',
      targetThrough: 30, expectedAfterOrdinal: 0,
    });
    insertRowsBatch(db, {
      chatId: 'chat-0002', transcriptViewId: 'view-0002',
      rows: syntheticRows({ seed: 1, count: 10 }), advanceTo: 10,
    });
    const resumed = planChatSync(db, {
      mode: 'replace', chatId: 'chat-0002', transcriptViewId: 'view-0002',
      targetThrough: 30, expectedAfterOrdinal: 0,
    });
    expect(resumed).toMatchObject({ plan: 'build', staleRows: false });
    expect(resumed.state.indexedThrough).toBe(10);
    insertRowsBatch(db, {
      chatId: 'chat-0002', transcriptViewId: 'view-0002',
      rows: syntheticRows({ seed: 2, count: 20, startOrdinal: 11 }), advanceTo: 30,
    });
    finishChatSync(db, { chatId: 'chat-0002', transcriptViewId: 'view-0002' });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM search_chunks WHERE chat_id = 'chat-0002'",
    ).get()).toEqual({ count: 30 });
    db.close();
  });

  test('[TLV5-SEARCH.07-SCHEMA-02] view replacement cleans stale rows in bounded batches', async () => {
    const db = await openFresh();
    buildChat(db, 'chat-0003', 'view-a', 25);
    const plan = planChatSync(db, {
      mode: 'replace', chatId: 'chat-0003', transcriptViewId: 'view-b',
      targetThrough: 5, expectedAfterOrdinal: 0,
    });
    expect(plan).toMatchObject({ plan: 'build', staleRows: true });
    let total = 0;
    let deleted = 0;
    do {
      deleted = deleteStaleRowsBatch(db, {
        chatId: 'chat-0003', keepViewId: 'view-b', keepThrough: 0, limit: 8,
      });
      expect(deleted).toBeLessThanOrEqual(8);
      total += deleted;
    } while (deleted > 0);
    expect(total).toBe(25);
    db.close();
  });

  test('[TLV5-SEARCH.07-SCHEMA-03] enforces row, byte, ordering, and frontier caps', async () => {
    const db = await openFresh();
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-0004', transcriptViewId: 'view-0004',
      targetThrough: 1_000, expectedAfterOrdinal: 0,
    });
    expect(() => insertRowsBatch(db, {
      chatId: 'chat-0004', transcriptViewId: 'view-0004',
      rows: syntheticRows({ seed: 2, count: SEARCH_INGEST_TXN_MAX_ROWS + 1 }),
      advanceTo: SEARCH_INGEST_TXN_MAX_ROWS + 1,
    })).toThrow('SEARCH_BATCH_TOO_LARGE');
    expect(() => insertRowsBatch(db, {
      chatId: 'chat-0004', transcriptViewId: 'view-0004',
      rows: [...syntheticRows({ seed: 2, count: 2 })].reverse(), advanceTo: 2,
    })).toThrow('SEARCH_ROW_INVALID');
    const before = db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value;
    expect(() => insertRowsBatch(db, {
      chatId: 'chat-0004', transcriptViewId: 'view-0004',
      rows: [{
        ...syntheticRows({ seed: 2, count: 1 })[0]!,
        body: 'a'.repeat(SEARCH_INGEST_ROW_MAX_BYTES + 1),
      }],
      advanceTo: 1,
    })).toThrow('SEARCH_ROW_TOO_LARGE');
    expect(db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value)
      .toBe(before);
    expect(() => finishChatSync(db, {
      chatId: 'chat-0004', transcriptViewId: 'view-0004',
    })).toThrow('SEARCH_FRONTIER_INVALID');
    db.close();
  });

  test('[TLV5-SEARCH.01-SCHEMA-01] append retains rows and validates position', async () => {
    const db = await openFresh();
    buildChat(db, 'chat-0005', 'view-0005', 12);
    expect(planChatSync(db, {
      mode: 'append', chatId: 'chat-0005', transcriptViewId: 'view-0005',
      targetThrough: 15, expectedAfterOrdinal: 12,
    })).toMatchObject({ plan: 'build', staleRows: false });
    expect(() => planChatSync(db, {
      mode: 'append', chatId: 'chat-0005', transcriptViewId: 'view-0005',
      targetThrough: 20, expectedAfterOrdinal: 17,
    })).toThrow('SEARCH_INDEX_GAP');
    expect(() => planChatSync(db, {
      mode: 'append', chatId: 'chat-0005', transcriptViewId: 'view-other',
      targetThrough: 20, expectedAfterOrdinal: 12,
    })).toThrow('SEARCH_VIEW_MISMATCH');
    db.close();
  });

  test('[TLV5-SEARCH.08-SCHEMA-01] failures isolate and deletion stays bounded', async () => {
    const db = await openFresh();
    buildChat(db, 'chat-0006', 'view-0006', 40);
    buildChat(db, 'chat-0007', 'view-0007', 4);
    markChatFailed(db, {
      chatId: 'chat-0007', transcriptViewId: 'view-0007', errorCode: 'SEARCH_ROW_TOO_LARGE',
    });
    expect(statusCounts(db)).toMatchObject({ indexed: 1, failed: 1, pending: 0 });
    let calls = 0;
    while (true) {
      calls += 1;
      if (deleteChatBatch(db, 'chat-0006', 16).done) break;
    }
    expect(calls).toBe(3);
    expect(getChatState(db, 'chat-0006')).toBeNull();
    expect(listChatStates(db).map((state) => state.chatId)).toEqual(['chat-0007']);
    db.close();
  });

  test('[TLV5-SEARCH.08-SCHEMA-02] failure view semantics preserve only valid progress', async () => {
    const db = await openFresh();
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-0008', transcriptViewId: 'view-a',
      targetThrough: 9, expectedAfterOrdinal: 0,
    });
    insertRowsBatch(db, {
      chatId: 'chat-0008', transcriptViewId: 'view-a', rows: [], advanceTo: 5,
    });
    markChatFailed(db, {
      chatId: 'chat-0008', transcriptViewId: 'view-a', errorCode: 'SEARCH_ROW_INVALID',
    });
    expect(getChatState(db, 'chat-0008')).toMatchObject({
      status: 'failed', indexedThrough: 5, targetThrough: 9,
    });
    markChatFailed(db, {
      chatId: 'chat-0008', transcriptViewId: 'view-b', errorCode: 'LEDGER_FENCED',
    });
    expect(getChatState(db, 'chat-0008')).toMatchObject({
      transcriptViewId: 'view-b', status: 'failed', indexedThrough: 0, targetThrough: 0,
    });
    const before = db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value;
    expect(() => markChatFailed(db, {
      chatId: 'chat-0008', transcriptViewId: 'view-b', errorCode: 'not-valid',
    })).toThrow('INVALID_SEARCH_ERROR_CODE');
    expect(db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value)
      .toBe(before);
    db.close();
  });

  test('[TLV5-SEARCH.09-SCHEMA-01] queries expose only the committed searchable prefix', async () => {
    const db = await openFresh();
    const marker = 'prefixmarker';
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-0009', transcriptViewId: 'view-a',
      targetThrough: 2, expectedAfterOrdinal: 0,
    });
    insertRowsBatch(db, {
      chatId: 'chat-0009', transcriptViewId: 'view-a',
      rows: [{ ...syntheticRows({ seed: 1, count: 1 })[0]!, body: marker }],
      advanceTo: 1,
    });
    const pending = markerSearch(db, 'chat-0009', 'view-a', 2, marker);
    expect(pending.results).toHaveLength(1);
    expect(pending.index.pendingChatCount).toBe(1);

    markChatFailed(db, {
      chatId: 'chat-0009', transcriptViewId: 'view-a', errorCode: 'SEARCH_ROW_INVALID',
    });
    expect(markerSearch(db, 'chat-0009', 'view-a', 2, marker).results).toHaveLength(0);

    planChatSync(db, {
      mode: 'replace', chatId: 'chat-0009', transcriptViewId: 'view-b',
      targetThrough: 1, expectedAfterOrdinal: 0,
    });
    expect(markerSearch(db, 'chat-0009', 'view-a', 2, marker).results).toHaveLength(0);
    db.close();
  });

  test('[TLV5-SEARCH.09-SCHEMA-03] every query path stops at the request frontier', async () => {
    const db = await openFresh();
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-frontier', transcriptViewId: 'view-frontier',
      targetThrough: 2, expectedAfterOrdinal: 0,
    });
    insertRowsBatch(db, {
      chatId: 'chat-frontier',
      transcriptViewId: 'view-frontier',
      rows: [
        { ...syntheticRows({ seed: 1, count: 1 })[0]!, body: 'alphafrontier betafrontier' },
        {
          ...syntheticRows({ seed: 2, count: 1, startOrdinal: 2 })[0]!,
          body: 'alphafrontier betafrontier laterfrontier',
        },
      ],
      advanceTo: 2,
    });
    finishChatSync(db, { chatId: 'chat-frontier', transcriptViewId: 'view-frontier' });

    expect(markerSearch(
      db, 'chat-frontier', 'view-frontier', 1, 'laterfrontier',
    ).results).toHaveLength(0);
    const multi = searchTranscriptIndexV1(db, {
      query: {
        version: 1,
        clauses: [
          {
            kind: 'all-words',
            tokens: [{ text: 'alphafrontier', normalized: 'alphafrontier', match: 'exact' }],
          },
          {
            kind: 'all-words',
            tokens: [{ text: 'betafrontier', normalized: 'betafrontier', match: 'exact' }],
          },
        ],
      },
      allowedChats: [{
        chatId: 'chat-frontier', transcriptViewId: 'view-frontier', throughOrdinal: 1,
      }],
    });
    expect(multi.results).toEqual([
      expect.objectContaining({
        chatId: 'chat-frontier',
        matchedMessageCount: 1,
        snippets: [expect.objectContaining({ ordinal: 1 })],
      }),
    ]);
    expect(multi.index).toMatchObject({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unindexedChatCount: 0,
      unsupportedChatCount: 0,
      resultsTruncated: false,
    });
    db.close();
  });

  test('[TLV5-SEARCH.11-SCHEMA-01] bounds broad match materialization and preserves later exact queries', async () => {
    const db = await openFresh();
    const rowCount = SEARCH_QUERY_MATCH_ROW_LIMIT + 5;
    planChatSync(db, {
      mode: 'replace',
      chatId: 'chat-broad',
      transcriptViewId: 'view-broad',
      targetThrough: rowCount,
      expectedAfterOrdinal: 0,
    });
    for (let offset = 0; offset < rowCount; offset += SEARCH_INGEST_TXN_MAX_ROWS) {
      const count = Math.min(SEARCH_INGEST_TXN_MAX_ROWS, rowCount - offset);
      insertRowsBatch(db, {
        chatId: 'chat-broad',
        transcriptViewId: 'view-broad',
        rows: Array.from({ length: count }, (_, index) => {
          const ordinal = offset + index + 1;
          return {
            ordinal,
            role: ordinal % 2 === 0 ? 'assistant' as const : 'user' as const,
            timestamp: '2026-01-01T00:00:00.000Z',
            body: [
              'broadmarker',
              ordinal % 2 === 0 ? 'intersectionmarker' : '',
              ordinal === 1 ? 'oldestexactmarker' : '',
            ].filter(Boolean).join(' '),
          };
        }),
        advanceTo: offset + count,
      });
    }
    finishChatSync(db, { chatId: 'chat-broad', transcriptViewId: 'view-broad' });
    const search = (...markers: string[]) => searchTranscriptIndexV1(db, {
      query: {
        version: 1,
        clauses: markers.map((marker) => ({
          kind: 'all-words' as const,
          tokens: [{ text: marker, normalized: marker, match: 'exact' as const }],
        })),
      },
      allowedChats: [{
        chatId: 'chat-broad',
        transcriptViewId: 'view-broad',
        throughOrdinal: rowCount,
      }],
    });

    const broad = search('broadmarker');
    expect(broad.index.resultsTruncated).toBe(true);
    expect(broad.results).toEqual([
      expect.objectContaining({
        chatId: 'chat-broad',
        matchedMessageCount: SEARCH_QUERY_MATCH_ROW_LIMIT,
      }),
    ]);
    expect(broad.results[0]!.snippets.every((snippet) => snippet.ordinal > 1)).toBe(true);

    const intersection = search('broadmarker', 'intersectionmarker');
    expect(intersection.index.resultsTruncated).toBe(true);
    expect(intersection.results).toEqual([
      expect.objectContaining({ chatId: 'chat-broad' }),
    ]);

    const exact = search('oldestexactmarker');
    expect(exact.index.resultsTruncated).toBe(false);
    expect(exact.results).toEqual([
      expect.objectContaining({
        chatId: 'chat-broad',
        matchedMessageCount: 1,
        snippets: [expect.objectContaining({ ordinal: 1 })],
      }),
    ]);
    db.close();
  });

  test('pages 500 distinct chats and honors ordered allowlist priority', async () => {
    const db = await openFresh();
    const marker = 'paginationmarker';
    const allowedChats = Array.from({ length: 525 }, (_, index) => {
      const suffix = String(index).padStart(4, '0');
      const chatId = `chat-page-${suffix}`;
      const transcriptViewId = `view-page-${suffix}`;
      buildChat(db, chatId, transcriptViewId, 1, marker);
      return { chatId, transcriptViewId, throughOrdinal: 1 };
    });
    const query = {
      version: 1 as const,
      clauses: [{
        kind: 'all-words' as const,
        tokens: [{ text: marker, normalized: marker, match: 'exact' as const }],
      }],
    };
    const pages = Array.from({ length: 10 }, (_, index) => searchTranscriptIndexV1(db, {
      query,
      allowedChats,
      order: 'relevance',
      offset: index * 50,
      limit: 50,
    }));
    const resultIds = pages.flatMap((page) => page.results.map((result) => result.chatId));
    expect(resultIds).toHaveLength(500);
    expect(new Set(resultIds).size).toBe(500);
    expect(pages[0]!.page).toEqual({
      offset: 0, limit: 50, total: 525, hasMore: true, nextOffset: 50,
    });
    expect(pages[0]).toMatchObject({ mode: 'page', snippetLimit: 3 });
    expect(pages[9]!.page).toEqual({
      offset: 450, limit: 50, total: 525, hasMore: true, nextOffset: 500,
    });
    expect(pages[9]!.results[0]).toMatchObject({
      matchedMessageCount: 1,
      snippets: [expect.objectContaining({ ordinal: 1 })],
    });

    const reversed = [...allowedChats].reverse();
    const allowlistPage = searchTranscriptIndexV1(db, {
      query,
      allowedChats: reversed,
      order: 'allowlist',
      offset: 50,
      limit: 50,
    });
    expect(allowlistPage.results.map((result) => result.chatId))
      .toEqual(reversed.slice(50, 100).map((entry) => entry.chatId));
    const compactPrefix = searchTranscriptIndexV1(db, {
      query,
      allowedChats,
      order: 'relevance',
      mode: 'prefix',
      offset: 0,
      limit: 500,
      snippetLimit: 1,
    });
    expect(compactPrefix).toMatchObject({
      mode: 'prefix',
      snippetLimit: 1,
      page: {
        offset: 0,
        limit: 500,
        total: 525,
        hasMore: true,
        nextOffset: 500,
      },
    });
    expect(compactPrefix.results.map((result) => result.chatId)).toEqual(resultIds);
    expect(compactPrefix.results).toHaveLength(500);
    expect(compactPrefix.results.every((result) => result.snippets.length === 1)).toBe(true);
    expect(compactPrefix.results[0]).toMatchObject({
      score: pages[0]!.results[0]!.score,
      matchedMessageCount: 1,
      snippets: [pages[0]!.results[0]!.snippets[0]],
    });
    const finalPage = searchTranscriptIndexV1(db, {
      query, allowedChats, order: 'relevance', offset: 500, limit: 50,
    });
    expect(finalPage.results).toHaveLength(25);
    expect(finalPage.page).toEqual({
      offset: 500, limit: 50, total: 525, hasMore: false, nextOffset: null,
    });
    const beyond = searchTranscriptIndexV1(db, {
      query, allowedChats, order: 'relevance', offset: 600, limit: 50,
    });
    expect(beyond.results).toEqual([]);
    expect(beyond.page).toEqual({
      offset: 600, limit: 50, total: 525, hasMore: false, nextOffset: null,
    });
    db.close();
  });

  test('returns normalized terminal pages for empty searches', async () => {
    const db = await openFresh();
    const emptyAllowlist = searchTranscriptIndexV1(db, {
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'empty', normalized: 'empty', match: 'exact' }],
        }],
      },
      allowedChats: [],
      offset: 25,
      limit: 500,
    });
    expect(emptyAllowlist.page).toEqual({
      offset: 25, limit: 100, total: 0, hasMore: false, nextOffset: null,
    });
    const emptyTerms = searchTranscriptIndexV1(db, {
      query: { version: 1, clauses: [] },
      allowedChats: [],
      offset: 12,
      limit: 25,
    });
    expect(emptyTerms.page).toEqual({
      offset: 12, limit: 25, total: 0, hasMore: false, nextOffset: null,
    });
    db.close();
  });

  test('[TLV5-SEARCH.07-SCHEMA-05] timestamp bytes are bounded in code and storage', async () => {
    const db = await openFresh();
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-timestamp', transcriptViewId: 'view-timestamp',
      targetThrough: 1, expectedAfterOrdinal: 0,
    });
    const base = syntheticRows({ seed: 1, count: 1 })[0]!;
    const before = db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value;
    const oversized = 'é'.repeat(SEARCH_TIMESTAMP_MAX_BYTES / 2 + 1);
    expect(() => insertRowsBatch(db, {
      chatId: 'chat-timestamp', transcriptViewId: 'view-timestamp',
      rows: [{ ...base, timestamp: oversized }], advanceTo: 1,
    })).toThrow('SEARCH_ROW_INVALID');
    expect(db.query<{ value: number }, []>('SELECT total_changes() AS value').get()!.value)
      .toBe(before);
    expect(() => db.query(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('chat-timestamp', 'view-timestamp', 1, 0, oversized, 'body')).toThrow();

    insertRowsBatch(db, {
      chatId: 'chat-timestamp', transcriptViewId: 'view-timestamp',
      rows: [{ ...base, timestamp: 'é'.repeat(SEARCH_TIMESTAMP_MAX_BYTES / 2) }], advanceTo: 1,
    });
    finishChatSync(db, { chatId: 'chat-timestamp', transcriptViewId: 'view-timestamp' });
    const chunkColumns = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_xinfo('search_chunks') ORDER BY cid",
    ).all().map((row) => row.name);
    const ftsColumns = db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_xinfo('search_chunks_fts') ORDER BY cid",
    ).all().map((row) => row.name);
    expect(chunkColumns).not.toContain('chat_scope');
    expect(ftsColumns).not.toContain('chat_scope');
    db.close();
  });

  test('[TLV5-SEARCH.09-SCHEMA-02] physical deletion settles after a verified checkpoint', async () => {
    const db = await openFresh();
    const marker = 'privacysettlementmarker';
    buildChat(db, 'chat-0010', 'view-0010', 32, marker);
    const pinned = openSearchReadDatabase(dbPath);
    pinned.exec('BEGIN');
    pinned.query('SELECT COUNT(*) AS count FROM search_chunks').get();

    while (!deleteChatBatch(db, 'chat-0010', 8).done) {}
    const fresh = openSearchReadDatabase(dbPath);
    expect(markerSearch(fresh, 'chat-0010', 'view-0010', 32, marker).results).toHaveLength(0);
    fresh.close();
    expect(observeWalTruncate(db).busy).not.toBe(0);

    pinned.exec('COMMIT');
    pinned.close();
    expect(observeWalTruncate(db).busy).toBe(0);
    closeSearchDatabase(db);
    for (const file of [dbPath, `${dbPath}-wal`]) {
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(marker))).toBe(false);
    }
  });

  test('[TLV5-SEARCH.06-SCHEMA-02] sparse source pages advance without chunks', async () => {
    const db = await openFresh();
    planChatSync(db, {
      mode: 'replace', chatId: 'chat-0011', transcriptViewId: 'view-0011',
      targetThrough: 9, expectedAfterOrdinal: 0,
    });
    insertRowsBatch(db, {
      chatId: 'chat-0011', transcriptViewId: 'view-0011', rows: [], advanceTo: 9,
    });
    expect(finishChatSync(db, {
      chatId: 'chat-0011', transcriptViewId: 'view-0011',
    })).toMatchObject({ status: 'indexed', indexedThrough: 9, targetThrough: 9 });
    runIdleMaintenance(db);
    db.close();
  });
});
