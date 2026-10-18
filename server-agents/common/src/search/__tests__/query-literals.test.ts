import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileChatSearchQuery, type TranscriptSearchAllowedChat } from '@garcon/common/chat-search';
import { SEARCH_QUERY_MATCH_ROW_LIMIT, searchTranscriptIndexV1 } from '../query.js';
import {
  finishChatSync,
  insertRowsBatch,
  openSearchDatabase,
  planChatSync,
  SEARCH_INGEST_TXN_MAX_ROWS,
} from '../schema.js';

let directory: string;
let db: Database;
let allowedChats: TranscriptSearchAllowedChat[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'search-literals-'));
  db = (await openSearchDatabase(join(directory, 'index.sqlite'))).db;
  allowedChats = [];
});

afterEach(() => {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

function addChat(chatId: string, bodies: string[]): void {
  const transcriptViewId = `view-${chatId}`;
  planChatSync(db, {
    mode: 'replace',
    chatId,
    transcriptViewId,
    targetThrough: bodies.length,
    expectedAfterOrdinal: 0,
  });
  for (let offset = 0; offset < bodies.length; offset += SEARCH_INGEST_TXN_MAX_ROWS) {
    const batch = bodies.slice(offset, offset + SEARCH_INGEST_TXN_MAX_ROWS);
    insertRowsBatch(db, {
      chatId,
      transcriptViewId,
      rows: batch.map((body, index) => ({
        ordinal: offset + index + 1,
        role: 'tool',
        timestamp: null,
        body,
      })),
      advanceTo: offset + batch.length,
    });
  }
  finishChatSync(db, { chatId, transcriptViewId });
  allowedChats.push({ chatId, transcriptViewId, throughOrdinal: bodies.length });
}

function search(query: string, offset = 0, limit = 20) {
  return searchTranscriptIndexV1(db, {
    query: compileChatSearchQuery(query),
    allowedChats,
    order: 'allowlist',
    offset,
    limit,
  });
}

describe('literal identifier search', () => {
  test('rejects numeric noise and longer identifiers, quoted or unquoted', () => {
    addChat('wanted', ['Review #731.']);
    addChat('adjacent', ['Review PR#731.']);
    addChat('noise', ['731: synthetic source line', '00:00:00.731Z', '731123 numeric identifier']);
    addChat('longer', ['Review #7310 and #731suffix and #731_suffix.']);
    for (const query of ['#731', '"#731"', "'#731'"]) {
      const result = search(query);
      expect(result.results.map((entry) => entry.chatId)).toEqual(['wanted', 'adjacent']);
      expect(result.page.total).toBe(2);
      expect(result.results.every((entry) => entry.matchedMessageCount === 1)).toBe(true);
      expect(result.results.every((entry) => entry.snippets[0]!.text.includes('#731'))).toBe(true);
    }
    expect(search('731').page.total).toBe(4);
    expect(search('"731"').page.total).toBe(4);
  });

  test.each([
    { query: 'ABC-123', body: 'abc-123', decoy: 'ABC 123', longer: 'ABC-123suffix' },
    { query: '/workspace/src/index.ts', body: '/WORKSPACE/src/index.ts', decoy: '/workspace/src/index ts', longer: '/workspace/src/index.tsx' },
    { query: 'C:\\workspace\\index.ts', body: 'C:\\workspace\\index.ts', decoy: 'C workspace index ts', longer: 'C:\\workspace\\index.tsx' },
    { query: 'file_name', body: 'file_name', decoy: 'file name', longer: 'file_names' },
    { query: 'C++', body: 'C++', decoy: 'C', longer: 'XC++' },
    { query: 'dev@example.test', body: 'DEV@example.test', decoy: 'dev example test', longer: 'otherdev@example.test' },
    { query: 'x.y[1]', body: 'x.y[1]', decoy: 'xay 1', longer: 'ax.y[1]' },
    { query: '"PR #731"', body: 'PR #731', decoy: 'PR 731', longer: 'PR #7310' },
  ])('preserves literal punctuation in $query', ({ query, body, decoy, longer }) => {
    addChat('wanted', [body]);
    addChat('decoy', [decoy]);
    addChat('longer', [longer]);
    expect(search(query).results.map((entry) => entry.chatId)).toEqual(['wanted']);
    expect(search(query).results[0]!.snippets[0]!.text).toBe(body);
  });

  test('filters before paging, chat-scope intersection, counts, and snippet selection', () => {
    addChat('noise-first', ['731 marker']);
    addChat('wanted-first', ['731 decoy before the real match', '#731', 'marker']);
    addChat('wrong-clause', ['#731']);
    addChat('wanted-last', ['#731 marker']);
    const first = search('#731 marker', 0, 1);
    expect(first.results.map((entry) => entry.chatId)).toEqual(['wanted-first']);
    expect(first.page).toEqual({ offset: 0, limit: 1, total: 2, hasMore: true, nextOffset: 1 });
    expect(first.results[0]!.matchedMessageCount).toBe(2);
    expect(first.results[0]!.snippets.map((snippet) => snippet.ordinal)).toEqual([2, 3]);
    const last = search('#731 marker', 1, 1);
    expect(last.results.map((entry) => entry.chatId)).toEqual(['wanted-last']);
    expect(last.page).toEqual({ offset: 1, limit: 1, total: 2, hasMore: false, nextOffset: null });
  });

  test('anchors snippets at the literal occurrence rather than an earlier numeric decoy', () => {
    addChat('wanted', [`731 ${'synthetic context '.repeat(40)}#731.`]);
    const snippet = search('#731').results[0]!.snippets[0]!;
    expect(snippet.text).toContain('#731');
    expect(snippet.text).toStartWith('... ');
    addChat('leading', ['#731.']);
    expect(search('#731').results[1]!.snippets[0]!.text).toBe('#731.');
  });

  test('keeps sampling truthful when literal candidates exceed the row ceiling', () => {
    addChat('sampled', [
      '#731',
      ...Array.from({ length: SEARCH_QUERY_MATCH_ROW_LIMIT }, () => '731: synthetic source line'),
    ]);
    const sampled = search('#731');
    expect(sampled.results).toEqual([]);
    expect(sampled.page.total).toBe(0);
    expect(sampled.index.resultsTruncated).toBe(true);
    expect(search('"731"').results[0]!.matchedMessageCount).toBe(SEARCH_QUERY_MATCH_ROW_LIMIT);
  });

  test('keeps current-view frontiers and allowlists authoritative for literal results', () => {
    addChat('wanted', ['731', '#731']);
    addChat('excluded', ['#731']);
    allowedChats = [{ ...allowedChats[0]!, throughOrdinal: 1 }];
    expect(search('#731').results).toEqual([]);
    allowedChats[0] = { ...allowedChats[0]!, throughOrdinal: 2 };
    expect(search('#731').results.map((entry) => entry.chatId)).toEqual(['wanted']);
    allowedChats[0] = { ...allowedChats[0]!, transcriptViewId: 'stale-view' };
    expect(search('#731').results).toEqual([]);
  });

  test('rejects literal clauses whose candidate tokens do not describe their text', () => {
    const query = compileChatSearchQuery('#731');
    expect(() => searchTranscriptIndexV1(db, {
      allowedChats,
      query: {
        ...query,
        clauses: [{
          kind: 'literal', text: '#732', tokens: query.clauses[0]!.tokens,
        }],
      },
    })).toThrow('Transcript search literal is invalid');
  });
});
