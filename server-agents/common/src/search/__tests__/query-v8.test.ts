import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatSearchQueryV1, TranscriptSearchAllowedChat } from '@garcon/common/chat-search';
import {
  compileTranscriptSearchQueryV1,
  createTranscriptSearchAllowlist,
  createTranscriptSearchReaderSession,
  SEARCH_READER_MAX_BODY_BYTES,
  SEARCH_READER_MAX_BODY_ROWS,
  SEARCH_READER_MAX_POSITION_OPERATIONS,
  SEARCH_READER_MAX_SQL_ROWS,
  SEARCH_READER_MAX_TERM_POSITION_BYTES,
  SEARCH_QUERY_MAX_NATIVE_TOKENS,
  searchTranscriptIndexV1,
} from '../query.js';

const databases: Database[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function initializeDatabase(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE search_chat_state (
      chat_id TEXT PRIMARY KEY,
      transcript_view_id TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      target_through INTEGER NOT NULL,
      processed_through INTEGER NOT NULL,
      active_chunk_id INTEGER,
      slot_document_count INTEGER NOT NULL,
      slot_token_count INTEGER NOT NULL,
      last_error_code TEXT,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE search_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      transcript_view_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role INTEGER NOT NULL,
      timestamp TEXT,
      body TEXT NOT NULL,
      body_bytes INTEGER NOT NULL,
      token_count INTEGER NOT NULL,
      term_count INTEGER NOT NULL,
      term_bytes INTEGER NOT NULL,
      position_bytes INTEGER NOT NULL,
      UNIQUE(chat_id, transcript_view_id, ordinal)
    ) STRICT;
    CREATE TABLE search_chunk_progress (
      chunk_id INTEGER PRIMARY KEY,
      complete INTEGER NOT NULL,
      persisted_term_count INTEGER NOT NULL,
      persisted_occurrence_count INTEGER NOT NULL,
      persisted_term_bytes INTEGER NOT NULL,
      persisted_position_bytes INTEGER NOT NULL,
      term_cursor BLOB
    ) STRICT;
    CREATE TABLE search_chunk_terms (
      chunk_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      term BLOB NOT NULL,
      frequency INTEGER NOT NULL,
      positions BLOB NOT NULL,
      PRIMARY KEY(chunk_id, term)
    ) WITHOUT ROWID, STRICT;
    CREATE INDEX search_chunk_terms_by_term
      ON search_chunk_terms(term, chat_id, chunk_id);
    CREATE TABLE search_corpus_stats (
      singleton INTEGER PRIMARY KEY,
      document_count INTEGER NOT NULL,
      total_token_count INTEGER NOT NULL
    ) WITHOUT ROWID, STRICT;
    INSERT INTO search_corpus_stats VALUES (1, 0, 0);
  `);
}

function database(): Database {
  const db = new Database(':memory:');
  databases.push(db);
  initializeDatabase(db);
  return db;
}

function tempAllowlistCount(db: Database): number {
  return Number(db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM sqlite_temp_master
    WHERE type = 'table' AND name = 'search_query_allowlist'
  `).get()?.count);
}

function diskDatabase(): { reader: Database; writer: Database } {
  const directory = mkdtempSync(path.join(tmpdir(), 'garcon-query-v8-'));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, 'search.sqlite');
  const reader = new Database(dbPath);
  databases.push(reader);
  initializeDatabase(reader);
  const writer = new Database(dbPath);
  databases.push(writer);
  writer.exec('PRAGMA journal_mode = WAL');
  return { reader, writer };
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

const tokenizer = {
  tokenizeQuery(text: string) {
    return [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((match, position) => ({
      term: Buffer.from(normalized(match[0])),
      position,
    }));
  },
};

function encodePositions(positions: readonly number[]): Buffer {
  const bytes: number[] = [];
  let previous = -1;
  for (const position of positions) {
    let delta = position - previous;
    do {
      const group = delta & 0x7f;
      delta >>>= 7;
      bytes.push(group | (delta > 0 ? 0x80 : 0));
    } while (delta > 0);
    previous = position;
  }
  return Buffer.from(bytes);
}

function postings(body: string): Array<{ term: Buffer; positions: number[] }> {
  const byTerm = new Map<string, { term: Buffer; positions: number[] }>();
  for (const token of tokenizer.tokenizeQuery(body)) {
    const term = Buffer.from(token.term);
    const key = term.toString('hex');
    const posting = byTerm.get(key) ?? { term, positions: [] };
    posting.positions.push(token.position);
    byTerm.set(key, posting);
  }
  return [...byTerm.values()].sort((left, right) => Buffer.compare(left.term, right.term));
}

function seedChat(
  db: Database,
  input: {
    chatId: string;
    viewId?: string;
    status?: 'indexed' | 'pending' | 'failed';
    bodies: readonly string[];
  },
): void {
  const viewId = input.viewId ?? `${input.chatId}-view`;
  const status = input.status ?? 'indexed';
  const phase = status === 'indexed' ? 'idle' : 'append-build';
  const tokenCounts = input.bodies.map((body) => tokenizer.tokenizeQuery(body).length + 1);
  db.query(`
    INSERT INTO search_chat_state VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    input.chatId,
    viewId,
    status,
    phase,
    input.bodies.length,
    input.bodies.length,
    input.bodies.length,
    tokenCounts.reduce((sum, count) => sum + count, 0),
    status === 'failed' ? 'CONTENT_REJECTED' : null,
    '2026-01-01T00:00:00.000Z',
  );
  for (let index = 0; index < input.bodies.length; index += 1) {
    const body = input.bodies[index];
    const bodyPostings = postings(body);
    const encoded = bodyPostings.map((posting) => encodePositions(posting.positions));
    const chunk = db.query<{ id: number }, [string, string, number, number, string, number, number, number, number]>(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
        token_count, term_count, term_bytes, position_bytes
      ) VALUES (?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      input.chatId,
      viewId,
      index + 1,
      body,
      Buffer.byteLength(body),
      tokenCounts[index],
      bodyPostings.length,
      bodyPostings.reduce((sum, posting) => sum + posting.term.byteLength, 0),
      encoded.reduce((sum, positions) => sum + positions.byteLength, 0),
    )!;
    const cursor = bodyPostings.at(-1)?.term ?? null;
    db.query('INSERT INTO search_chunk_progress VALUES (?, 1, ?, ?, ?, ?, ?)').run(
      chunk.id,
      bodyPostings.length,
      tokenCounts[index] - 1,
      bodyPostings.reduce((sum, posting) => sum + posting.term.byteLength, 0),
      encoded.reduce((sum, positions) => sum + positions.byteLength, 0),
      cursor,
    );
    for (let posting = 0; posting < bodyPostings.length; posting += 1) {
      db.query('INSERT INTO search_chunk_terms VALUES (?, ?, ?, ?, ?)').run(
        chunk.id,
        input.chatId,
        bodyPostings[posting].term,
        bodyPostings[posting].positions.length,
        encoded[posting],
      );
    }
  }
  if (status === 'indexed') {
    db.query(`
      UPDATE search_corpus_stats SET
        document_count = document_count + ?, total_token_count = total_token_count + ?
      WHERE singleton = 1
    `).run(input.bodies.length, tokenCounts.reduce((sum, count) => sum + count, 0));
  }
}

function allowed(chatId: string, throughOrdinal = 1): TranscriptSearchAllowedChat {
  return { chatId, transcriptViewId: `${chatId}-view`, throughOrdinal };
}

function exact(...texts: string[]): ChatSearchQueryV1 {
  return {
    version: 1,
    clauses: [{
      kind: 'all-words',
      tokens: texts.map((text) => ({ text, normalized: normalized(text), match: 'exact' })),
    }],
  };
}

function phrase(text: string): ChatSearchQueryV1 {
  return {
    version: 1,
    clauses: [{
      kind: 'phrase',
      tokens: [{ text, normalized: normalized(text), match: 'exact' }],
    }],
  };
}

function expectedBm25(frequency: number, dl: number, average: number, df: number, n: number): number {
  const idf = Math.max(Math.log((n - df + 0.5) / (df + 0.5)), 1e-6);
  return idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * dl / average));
}

describe('relational transcript query v8', () => {
  test('native query-token limits reject before opening a persistent snapshot', () => {
    const db = database();
    const atLimit = Array.from({ length: SEARCH_QUERY_MAX_NATIVE_TOKENS }, () => 'a').join('_');
    expect(() => compileTranscriptSearchQueryV1(tokenizer, exact(atLimit))).not.toThrow();
    expect(() => compileTranscriptSearchQueryV1(tokenizer, exact(`${atLimit}_a`)))
      .toThrow('INVALID_SEARCH_QUERY');
    expect(() => compileTranscriptSearchQueryV1(tokenizer, exact('a'.repeat(32 * 1024))))
      .not.toThrow();
    expect(() => compileTranscriptSearchQueryV1(tokenizer, exact('a'.repeat(32 * 1024 + 1))))
      .toThrow('INVALID_SEARCH_QUERY');
    expect(db.inTransaction).toBe(false);
  });

  test('[TLV5-SEARCH.07-ACTIVE-COMPLETE-CORE-UNIT-01] global active-complete population affects rank while pending residue contributes nothing', () => {
    const db = database();
    seedChat(db, { chatId: 'allowed', bodies: ['needle'] });
    seedChat(db, { chatId: 'omitted', bodies: ['needle unrelated words make this document longer'] });
    seedChat(db, { chatId: 'pending', status: 'pending', bodies: ['needle needle needle'] });

    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query: exact('needle'),
      allowedChats: [allowed('allowed')],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBeCloseTo(expectedBm25(1, 2, 5, 2, 2), 12);
    expect(result.results.map((entry) => entry.chatId)).toEqual(['allowed']);

    db.query("UPDATE search_chat_state SET status='indexed', phase='idle', last_error_code=NULL WHERE chat_id='pending'").run();
    db.query('UPDATE search_corpus_stats SET document_count=3, total_token_count=14').run();
    const activated = searchTranscriptIndexV1(db, {
      tokenizer,
      query: exact('needle'),
      allowedChats: [allowed('allowed')],
    });
    expect(activated.results[0].score).not.toBeCloseTo(result.results[0].score, 12);
  });

  test('preserves byte-exact allowlist identities including surrounding whitespace', () => {
    const db = database();
    seedChat(db, { chatId: 'chat', viewId: 'view', bodies: ['decoy'] });
    seedChat(db, { chatId: ' chat ', viewId: ' view ', bodies: ['needle'] });

    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query: exact('needle'),
      allowedChats: [
        { chatId: 'chat', transcriptViewId: 'view', throughOrdinal: 1 },
        { chatId: ' chat ', transcriptViewId: ' view ', throughOrdinal: 1 },
      ],
    });

    expect(result.index).toEqual({
      indexedChatCount: 2,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    expect(result.results.map((entry) => [entry.chatId, entry.transcriptViewId])).toEqual([
      [' chat ', ' view '],
    ]);
    expect(tempAllowlistCount(db)).toBe(0);
  });

  test('rejects duplicate and conflicting exact allowlist identities atomically', () => {
    const db = database();
    const allowlist = createTranscriptSearchAllowlist(db);
    allowlist.append([
      { chatId: 'chat', transcriptViewId: 'view', throughOrdinal: 1 },
      { chatId: ' chat ', transcriptViewId: ' view ', throughOrdinal: 1 },
    ]);
    expect(() => allowlist.append([
      { chatId: 'duplicate', transcriptViewId: 'view', throughOrdinal: 1 },
      { chatId: 'duplicate', transcriptViewId: 'view', throughOrdinal: 1 },
    ])).toThrow('INVALID_SEARCH_REQUEST');
    expect(() => allowlist.append([
      { chatId: 'chat', transcriptViewId: 'other-view', throughOrdinal: 2 },
    ])).toThrow('INVALID_SEARCH_REQUEST');
    expect(db.query('SELECT chat_id AS chatId FROM temp.search_query_allowlist ORDER BY chat_id')
      .all()).toEqual([{ chatId: ' chat ' }, { chatId: 'chat' }]);
    allowlist.close();
    expect(tempAllowlistCount(db)).toBe(0);
  });

  test('[TLV5-SEARCH.05-CORE-UNIT-01] reports only covering same-view deterministic failures as failed', () => {
    const db = database();
    seedChat(db, { chatId: 'covering-failure', status: 'failed', bodies: ['needle'] });
    seedChat(db, { chatId: 'lagging-failure', status: 'failed', bodies: ['needle'] });

    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query: exact('needle'),
      allowedChats: [allowed('covering-failure'), allowed('lagging-failure', 2)],
    });

    expect(result.results).toEqual([]);
    expect(result.index).toEqual({
      indexedChatCount: 0,
      pendingChatCount: 1,
      failedChatCount: 1,
      unsupportedChatCount: 0,
    });
  });

  test('matches phrases and AND clauses across underscore, diacritics, Hangul, and CJK', () => {
    const db = database();
    seedChat(db, { chatId: 'unicode', bodies: ['Crème 東京 foo_bar 한글'] });
    seedChat(db, { chatId: 'gap', bodies: ['creme foo gap bar 東京 한글'] });

    for (const query of [exact('Crème', '東京', '한글'), phrase('foo_bar')]) {
      const result = searchTranscriptIndexV1(db, {
        tokenizer,
        query,
        allowedChats: [allowed('unicode'), allowed('gap')],
      });
      expect(result.results[0].chatId).toBe('unicode');
      expect(result.results[0].snippets[0]).toMatchObject({
        ordinal: 1,
        text: 'Crème 東京 foo_bar 한글',
      });
      if (query.clauses[0].kind === 'phrase') {
        expect(result.results.map((entry) => entry.chatId)).toEqual(['unicode']);
      }
    }
    expect(searchTranscriptIndexV1(db, {
      query: phrase('foo_bar'),
      allowedChats: [allowed('unicode'), allowed('gap')],
    }).results.map((entry) => entry.chatId)).toEqual(['unicode']);
  });

  test('matches SQLite FTS5 reference rank and order for the frozen tokenizer corpus', () => {
    const db = database();
    const reference = new Database(':memory:');
    databases.push(reference);
    reference.exec(`
      CREATE VIRTUAL TABLE reference_fts USING fts5(
        body, chat_scope, columnsize=0, tokenize='unicode61 remove_diacritics 2'
      );
    `);
    const bodies = [
      'alpha foo_bar Crème 東京 한글',
      'alpha foo gap bar cream 東京 한글',
      'other content only',
    ];
    for (let index = 0; index < bodies.length; index += 1) {
      seedChat(db, { chatId: `ref-${index + 1}`, bodies: [bodies[index]] });
      reference.query('INSERT INTO reference_fts(rowid, body, chat_scope) VALUES (?, ?, ?)')
        .run(index + 1, bodies[index], 'scope');
    }
    const cases: Array<{ query: ChatSearchQueryV1; match: string }> = [
      { query: exact('alpha'), match: 'body:"alpha"' },
      { query: phrase('foo_bar'), match: 'body:"foo bar"' },
      { query: exact('Crème'), match: 'body:"creme"' },
      { query: exact('東京', '한글'), match: 'body:"東京" AND body:"한글"' },
    ];
    for (const entry of cases) {
      const actual = searchTranscriptIndexV1(db, {
        tokenizer,
        query: entry.query,
        allowedChats: bodies.map((_, index) => allowed(`ref-${index + 1}`)),
      }).results;
      const expected = reference.query<{ rowId: number; score: number }, [string]>(`
        SELECT rowid AS rowId, -bm25(reference_fts, 1.0, 0.0) AS score
        FROM reference_fts WHERE reference_fts MATCH ?
        ORDER BY score DESC, rowid
      `).all(entry.match);
      expect(actual.map((result) => Number(result.chatId.slice(4))))
        .toEqual(expected.map((result) => result.rowId));
      expect(actual).toHaveLength(expected.length);
      for (let index = 0; index < actual.length; index += 1) {
        expect(actual[index].score).toBeCloseTo(expected[index].score, 12);
        expect(actual[index].snippets[0]).toMatchObject({
          ordinal: 1,
          text: bodies[expected[index].rowId - 1],
        });
      }
    }
  });

  test('sums each clause best document at chat scope', () => {
    const db = database();
    seedChat(db, { chatId: 'split', bodies: ['alpha', 'beta'] });
    seedChat(db, { chatId: 'partial', bodies: ['alpha'] });
    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query: {
        version: 1,
        clauses: [exact('alpha').clauses[0], exact('beta').clauses[0]],
      },
      allowedChats: [allowed('split', 2), allowed('partial')],
    });
    expect(result.results.map((entry) => entry.chatId)).toEqual(['split']);
    expect(result.results[0].matchedMessageCount).toBe(2);
  });

  test('compiles before BEGIN and retains one persistent snapshot through body reads', () => {
    const db = database();
    seedChat(db, { chatId: 'snapshot', bodies: ['stable needle'] });
    const compiled = compileTranscriptSearchQueryV1(tokenizer, exact('needle'));
    const session = createTranscriptSearchReaderSession(db, compiled, {
      allowedChats: [allowed('snapshot')],
    });
    expect(db.inTransaction).toBe(false);
    expect(session.step().type).toBe('continue');
    expect(db.inTransaction).toBe(true);
    while (session.step().type !== 'complete') {}
    expect(db.inTransaction).toBe(false);
  });

  test('[TLV5-SEARCH.07-READ-SNAPSHOT-CORE-UNIT-01] health, df, rank, snippet identity, and body use the same WAL snapshot', () => {
    const { reader, writer } = diskDatabase();
    seedChat(reader, { chatId: 'snapshot-wal', bodies: ['stable needle body'] });
    const session = createTranscriptSearchReaderSession(
      reader,
      compileTranscriptSearchQueryV1(tokenizer, exact('needle')),
      { allowedChats: [allowed('snapshot-wal')] },
    );
    expect(session.step().type).toBe('continue');
    writer.exec(`
      BEGIN IMMEDIATE;
      UPDATE search_chat_state
        SET status='pending', phase='append-build' WHERE chat_id='snapshot-wal';
      UPDATE search_corpus_stats SET document_count=0, total_token_count=0;
      UPDATE search_chunks SET body='replacement content', body_bytes=19
        WHERE chat_id='snapshot-wal';
      DELETE FROM search_chunk_terms WHERE chat_id='snapshot-wal';
      COMMIT;
    `);
    let completed: ReturnType<typeof session.step> | null = null;
    while (completed?.type !== 'complete') completed = session.step();
    expect(completed.result.index).toMatchObject({ indexedChatCount: 1, pendingChatCount: 0 });
    expect(completed.result.results).toHaveLength(1);
    expect(completed.result.results[0].snippets[0].text).toBe('stable needle body');
  });

  test('cancel rolls back the one persistent reader snapshot', () => {
    const db = database();
    seedChat(db, { chatId: 'cancel', bodies: ['needle'] });
    const session = createTranscriptSearchReaderSession(
      db,
      compileTranscriptSearchQueryV1(tokenizer, exact('needle')),
      { allowedChats: [allowed('cancel')] },
    );
    expect(session.step().type).toBe('continue');
    expect(db.inTransaction).toBe(true);
    session.cancel();
    expect(db.inTransaction).toBe(false);
    expect(tempAllowlistCount(db)).toBe(0);
  });

  test('malformed active postings fail closed and roll back without a result', () => {
    const db = database();
    seedChat(db, { chatId: 'corrupt', bodies: ['needle'] });
    db.query("UPDATE search_chunk_terms SET positions=x'8100' WHERE chat_id='corrupt'").run();
    const session = createTranscriptSearchReaderSession(
      db,
      compileTranscriptSearchQueryV1(tokenizer, exact('needle')),
      { allowedChats: [allowed('corrupt')] },
    );
    let error: unknown = null;
    try {
      while (session.step().type !== 'complete') {}
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('SEARCH_INDEX_CORRUPT');
    expect(db.inTransaction).toBe(false);
  });

  test('a forged term chat copy raises content-free derived corruption before any result', () => {
    const db = database();
    seedChat(db, { chatId: 'owner', bodies: ['needle private body'] });
    seedChat(db, { chatId: 'forged', bodies: [] });
    db.query("UPDATE search_chunk_terms SET chat_id='forged' WHERE chat_id='owner'").run();
    const allowedChats = [allowed('owner'), allowed('forged', 0)];
    expect(() => searchTranscriptIndexV1(db, {
      tokenizer,
      query: exact('needle'),
      allowedChats,
    })).toThrow('SEARCH_INDEX_CORRUPT');
    expect(db.inTransaction).toBe(false);
    expect(() => searchTranscriptIndexV1(db, {
      tokenizer,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'nee', normalized: 'nee', match: 'prefix' }],
        }],
      },
      allowedChats,
    })).toThrow('SEARCH_INDEX_CORRUPT');
    expect(db.inTransaction).toBe(false);
  });

  test('[TLV5-SEARCH.07-READER-SLICE-CORE-UNIT-01] every resumable slice remains within caps and hot postings yield at 4096 operations', () => {
    const db = database();
    const hot = Array.from({ length: 5_000 }, () => 'hot').join(' ');
    seedChat(db, { chatId: 'hot', bodies: [hot] });
    const compiled = compileTranscriptSearchQueryV1(tokenizer, exact('hot'));
    const session = createTranscriptSearchReaderSession(db, compiled, {
      allowedChats: [allowed('hot')],
    });
    let sawFullPositionSlice = false;
    while (true) {
      const step = session.step();
      expect(step.metrics.sqlRows).toBeLessThanOrEqual(SEARCH_READER_MAX_SQL_ROWS);
      expect(step.metrics.termPositionBytes).toBeLessThanOrEqual(SEARCH_READER_MAX_TERM_POSITION_BYTES);
      expect(step.metrics.positionOperations).toBeLessThanOrEqual(SEARCH_READER_MAX_POSITION_OPERATIONS);
      expect(step.metrics.bodyRows).toBeLessThanOrEqual(SEARCH_READER_MAX_BODY_ROWS);
      expect(step.metrics.bodyBytes).toBeLessThanOrEqual(SEARCH_READER_MAX_BODY_BYTES);
      sawFullPositionSlice ||= step.metrics.positionOperations === SEARCH_READER_MAX_POSITION_OPERATIONS;
      if (step.type === 'complete') break;
    }
    expect(sawFullPositionSlice).toBe(true);
  });

  test('exact phrase df streams the sparse fixed-term index instead of scanning active chunks', () => {
    const db = database();
    seedChat(db, { chatId: 'allowed-exact', bodies: ['needle phrase'] });
    seedChat(db, { chatId: 'omitted-exact', bodies: ['needle elsewhere'] });
    for (let index = 0; index < 20; index += 1) {
      seedChat(db, { chatId: `noise-${index.toString().padStart(2, '0')}`, bodies: ['unrelated'] });
    }
    const original = db.query.bind(db);
    let driverSeeks = 0;
    let globalChunkPages = 0;
    let driverSql = '';
    Object.defineProperty(db, 'query', {
      configurable: true,
      value(sql: string) {
        if (sql.includes('INDEXED BY search_chunk_terms_by_term')) {
          driverSeeks += 1;
          driverSql = sql;
        }
        if (sql.includes('AND (chunks.chat_id > ? OR')) globalChunkPages += 1;
        return original(sql);
      },
    });
    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query: exact('needle'),
      allowedChats: [allowed('allowed-exact')],
    });
    expect(result.results.map((entry) => entry.chatId)).toEqual(['allowed-exact']);
    expect(driverSeeks).toBe(3);
    expect(globalChunkPages).toBe(0);
    const plan = original(`EXPLAIN QUERY PLAN ${driverSql}`)
      .all(Buffer.from('needle'), '', '', 0) as Array<{ detail: string }>;
    expect(plan.some((entry) => entry.detail.includes('search_chunk_terms_by_term'))).toBe(true);
    expect(plan.some((entry) => /SCAN search_chunks/i.test(entry.detail))).toBe(false);
  });

  test('global and allowlisted chunk keysets use the address index without temp sorting', () => {
    const db = database();
    seedChat(db, {
      chatId: 'active',
      bodies: Array.from({ length: 300 }, (_, index) => `needle active ${index}`),
    });
    seedChat(db, {
      chatId: 'pending-residue',
      status: 'pending',
      bodies: Array.from({ length: 300 }, (_, index) => `needle pending ${index}`),
    });
    const original = db.query.bind(db);
    let globalSql = '';
    let allowlistedSql = '';
    const tempAllowlistPlans = new Map<string, Array<{ detail: string }>>();
    Object.defineProperty(db, 'query', {
      configurable: true,
      value(sql: string) {
        if (sql.includes('FROM temp.search_query_allowlist allowed')
            && !tempAllowlistPlans.has(sql)) {
          const parameters = sql.includes('WHERE allowed.chat_id > ?') ? ['', 256] : [256];
          const explain = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
          try {
            tempAllowlistPlans.set(
              sql,
              explain.all(...parameters) as Array<{ detail: string }>,
            );
          } finally {
            explain.finalize();
          }
        }
        if (sql.includes('FROM search_chunks chunks INDEXED BY sqlite_autoindex_search_chunks_1')) {
          if (sql.includes('(chunks.chat_id, chunks.transcript_view_id, chunks.ordinal) >')) {
            globalSql = sql;
          } else if (sql.includes('AND chunks.chat_id = ? AND chunks.transcript_view_id = ?')) {
            allowlistedSql = sql;
          }
        }
        return original(sql);
      },
    });

    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'nee', normalized: 'nee', match: 'prefix' }],
        }],
      },
      allowedChats: [allowed('active', 300), allowed('pending-residue', 300)],
    });
    expect(result.results.map((entry) => entry.chatId)).toEqual(['active']);
    expect(globalSql).not.toBe('');
    expect(allowlistedSql).not.toBe('');

    const plans = [
      original(`EXPLAIN QUERY PLAN ${globalSql}`).all('', '', 0, 256),
      original(`EXPLAIN QUERY PLAN ${allowlistedSql}`).all('active', 'active-view', 300, 0),
    ] as Array<Array<{ detail: string }>>;
    for (const plan of plans) {
      expect(plan.some((entry) => entry.detail.includes(
        'SEARCH chunks USING INDEX sqlite_autoindex_search_chunks_1',
      ))).toBe(true);
      expect(plan.some((entry) => /SCAN chunks/i.test(entry.detail))).toBe(false);
      expect(plan.some((entry) => /USE TEMP B-TREE/i.test(entry.detail))).toBe(false);
    }
    expect(tempAllowlistPlans.size).toBe(2);
    for (const plan of tempAllowlistPlans.values()) {
      expect(plan.some((entry) => entry.detail.includes(
        'sqlite_autoindex_search_query_allowlist_1',
      ))).toBe(true);
      expect(plan.some((entry) => /USE TEMP B-TREE/i.test(entry.detail))).toBe(false);
    }
  });

  test('an over-cap yielded SQL cost closes the generator and rolls back the snapshot', () => {
    const db = database();
    seedChat(db, { chatId: 'over-cap', bodies: ['needle'] });
    const original = db.query.bind(db);
    Object.defineProperty(db, 'query', {
      configurable: true,
      value(sql: string) {
        if (sql.includes('(chunks.chat_id, chunks.transcript_view_id, chunks.ordinal) >')) {
          return {
            all() {
              return Array.from({ length: SEARCH_READER_MAX_SQL_ROWS + 1 }, (_, index) => ({
                id: index + 1,
                chatId: 'over-cap',
                transcriptViewId: 'over-cap-view',
                ordinal: index + 1,
                role: 1,
                timestamp: null,
                tokenCount: 2,
              }));
            },
          };
        }
        return original(sql);
      },
    });
    const session = createTranscriptSearchReaderSession(
      db,
      compileTranscriptSearchQueryV1(tokenizer, {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'nee', normalized: 'nee', match: 'prefix' }],
        }],
      }),
      { allowedChats: [allowed('over-cap')] },
    );

    expect(() => {
      while (session.step().type !== 'complete') {}
    }).toThrow('SEARCH_INDEX_CORRUPT');
    expect(db.inTransaction).toBe(false);
    expect(tempAllowlistCount(db)).toBe(0);
  });

  test('prefix no-match performs one initial chunk-major range seek per active chunk', () => {
    const db = database();
    seedChat(db, { chatId: 'one', bodies: ['alpha'] });
    seedChat(db, { chatId: 'two', bodies: ['beta'] });
    const original = db.query.bind(db);
    let initialPrefixSeeks = 0;
    Object.defineProperty(db, 'query', {
      configurable: true,
      value(sql: string) {
        if (sql.includes('terms.term >= ? AND terms.term < ?')) initialPrefixSeeks += 1;
        return original(sql);
      },
    });
    const query: ChatSearchQueryV1 = {
      version: 1,
      clauses: [{
        kind: 'all-words',
        tokens: [{ text: 'nomatch', normalized: 'nomatch', match: 'prefix' }],
      }],
    };
    const result = searchTranscriptIndexV1(db, {
      tokenizer,
      query,
      allowedChats: [allowed('one'), allowed('two')],
    });
    expect(result.results).toEqual([]);
    expect(initialPrefixSeeks).toBe(2);
  });
});
