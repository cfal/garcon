import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HistoricalSearchMessageRow } from '../rows.js';
import {
  SEARCH_INDEXER_CACHE_SIZE_PAGES,
  SEARCH_GREATEST_PERSISTED_POSTING_SQL,
  SEARCH_FIRST_SLOT_CHUNK_SQL,
  SEARCH_CHUNK_HAS_TERMS_SQL,
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_MAX_WAL_BYTES,
  SEARCH_NEXT_VIEW_CHUNK_SQL,
  SEARCH_PRUNE_CORPUS_SUBTRACT_SQL,
  SEARCH_PERSISTED_SUCCESSOR_SQL,
  SEARCH_RAW_DELETE_CANDIDATES_SQL,
  SEARCH_TERM_STEP_MAX_ROWS,
  SEARCH_WAL_HIGH_WATER_FRAMES,
  activateChat,
  advanceFrontier,
  buildTermStep,
  cleanupStep,
  closeSearchDatabase,
  completeReplacementCheckpoint,
  getChatState,
  markPrunedChats,
  observeWal,
  openSearchDatabase,
  openSearchReadDatabase,
  planAppend,
  planReplacement,
  readActiveChunkBody,
  stageRawChunks,
  truncateWal,
  type SearchChatState,
} from '../schema.js';
import { SearchTokenizer, type TokenizedDocument } from '../tokenizer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly root: string;
  readonly dbPath: string;
  readonly tokenizer: SearchTokenizer;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'transcript-search-schema-v8-'));
  roots.push(root);
  return {
    root,
    dbPath: path.join(root, 'index.sqlite'),
    tokenizer: SearchTokenizer.create(),
  };
}

function changes(db: Database): number {
  return Number(db.query<{ changes: number }, []>('SELECT total_changes() AS changes').get()?.changes);
}

function corpus(db: Database): { documents: number; tokens: number } {
  return db.query<{ documents: number; tokens: number }, []>(`
    SELECT document_count AS documents, total_token_count AS tokens
    FROM search_corpus_stats WHERE singleton = 1
  `).get()!;
}

function requireState(value: SearchChatState | undefined): SearchChatState {
  if (!value) throw new Error('test expected state');
  return value;
}

function completeBuild(
  db: Database,
  tokenizer: SearchTokenizer,
  state: SearchChatState,
  rows: readonly HistoricalSearchMessageRow[],
): SearchChatState {
  let current = state;
  if (rows.length > 0) {
    const batch = tokenizer.tokenizeDocuments(rows.map((row) => row.body));
    expect(batch.acceptedDocumentCount).toBe(rows.length);
    current = requireState(stageRawChunks(db, {
      expectedState: current,
      rows,
      documents: batch.documents,
    }).state);
    while (current.activeChunkId !== null) {
      const source = readActiveChunkBody(db, current);
      if (source.disposition !== 'current') throw new Error('test expected active chunk');
      current = requireState(buildTermStep(db, {
        expectedState: current,
        document: tokenizer.tokenizeDocument(source.body),
      }).state);
    }
  }
  if (current.processedThrough < current.targetThrough) {
    current = requireState(advanceFrontier(db, {
      expectedState: current,
      throughOrdinal: current.targetThrough,
    }).state);
  }
  return requireState(activateChat(db, { expectedState: current }).state);
}

describe('transcript search v8 schema', () => {
  it('creates the exact layout and recreates only version or fingerprint mismatches', async () => {
    const { dbPath, tokenizer } = await fixture();
    try {
      const first = await openSearchDatabase(dbPath, {
        tokenizerFingerprint: tokenizer.fingerprint,
      });
      expect(first.recreated).toBe(true);
      expect(first.db.query('PRAGMA user_version').get()).toEqual({ user_version: 8 });
      expect(first.db.query('PRAGMA page_size').get()).toEqual({ page_size: 4_096 });
      expect(first.db.query('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 0 });
      expect(first.db.query('PRAGMA wal_autocheckpoint').get()).toEqual({ wal_autocheckpoint: 0 });
      expect(first.db.query('PRAGMA cache_spill').get()).toEqual({ cache_spill: 0 });
      expect(first.db.query('PRAGMA cache_size').get()).toEqual({
        cache_size: SEARCH_INDEXER_CACHE_SIZE_PAGES,
      });
      const reader = openSearchReadDatabase(dbPath, {
        tokenizerFingerprint: tokenizer.fingerprint,
      });
      expect(reader.query('PRAGMA temp_store').get()).toEqual({ temp_store: 2 });
      reader.exec('CREATE TEMP TABLE allowed_chat_probe(chat_id TEXT PRIMARY KEY) WITHOUT ROWID');
      reader.query('INSERT INTO temp.allowed_chat_probe VALUES (?)').run('synthetic-chat');
      expect(reader.query('SELECT chat_id AS chatId FROM temp.allowed_chat_probe').get())
        .toEqual({ chatId: 'synthetic-chat' });
      expect(() => reader.query(`
        UPDATE search_corpus_stats SET document_count = 1 WHERE singleton = 1
      `).run()).toThrow();
      reader.close(false);
      const objectNames = first.db.query<{ name: string }, []>(`
        SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name
      `).all().map((entry) => entry.name);
      expect(objectNames).toContain('search_chunk_terms');
      expect(objectNames.some((name) => name.includes('fts'))).toBe(false);
      planReplacement(first.db, {
        chatId: 'resume-chat',
        transcriptViewId: 'resume-view',
        targetThrough: 1,
      });
      closeSearchDatabase(first.db);

      const resumed = await openSearchDatabase(dbPath, {
        tokenizerFingerprint: tokenizer.fingerprint,
      });
      expect(resumed.recreated).toBe(false);
      expect(getChatState(resumed.db, 'resume-chat')?.phase).toBe('replacement-build');
      closeSearchDatabase(resumed.db);

      const differentFingerprint = Uint8Array.from(tokenizer.fingerprint);
      differentFingerprint[0] ^= 0xff;
      const recreated = await openSearchDatabase(dbPath, {
        tokenizerFingerprint: differentFingerprint,
      });
      expect(recreated.recreated).toBe(true);
      expect(getChatState(recreated.db, 'resume-chat')).toBeNull();
      closeSearchDatabase(recreated.db);

      expect(SEARCH_TERM_STEP_MAX_ROWS).toBe(32);
      expect(SEARCH_MAX_DIRTY_FRAMES).toBe(49_829);
      expect(SEARCH_WAL_HIGH_WATER_FRAMES).toBe(199_316);
      expect(SEARCH_MAX_WAL_BYTES).toBe(821_181_952);
    } finally {
      tokenizer.close();
    }
  });

  it('keeps staged rows out of global population until activation', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      const initialPlan = planReplacement(opened.db, {
        chatId: 'population-chat',
        transcriptViewId: 'population-view',
        targetThrough: 1,
      });
      const indexed = completeBuild(opened.db, tokenizer, initialPlan.state, [{
        ordinal: 1,
        role: 'user',
        timestamp: null,
        body: 'synthetic initial body',
      }]);
      expect(corpus(opened.db)).toEqual({ documents: 1, tokens: 4 });

      const beforeCurrent = changes(opened.db);
      expect(planReplacement(opened.db, {
        chatId: indexed.chatId,
        transcriptViewId: indexed.transcriptViewId,
        targetThrough: indexed.targetThrough,
      })).toEqual({ disposition: 'current', state: indexed });
      expect(changes(opened.db)).toBe(beforeCurrent);

      const beforeCovered = changes(opened.db);
      expect(planReplacement(opened.db, {
        chatId: indexed.chatId,
        transcriptViewId: indexed.transcriptViewId,
        targetThrough: 0,
      })).toEqual({ disposition: 'current', state: indexed });
      expect(changes(opened.db)).toBe(beforeCovered);

      const append = planAppend(opened.db, {
        chatId: indexed.chatId,
        transcriptViewId: indexed.transcriptViewId,
        expectedAfterOrdinal: 1,
        targetThrough: 2,
      });
      expect(append.disposition).toBe('build');
      expect(corpus(opened.db)).toEqual({ documents: 0, tokens: 0 });
      const batch = tokenizer.tokenizeDocuments(['synthetic appended body']);
      let pending = requireState(stageRawChunks(opened.db, {
        expectedState: append.state,
        rows: [{
          ordinal: 2,
          role: 'assistant',
          timestamp: null,
          body: 'synthetic appended body',
        }],
        documents: batch.documents,
      }).state);
      const source = readActiveChunkBody(opened.db, pending);
      if (source.disposition !== 'current') throw new Error('test expected source');
      pending = requireState(buildTermStep(opened.db, {
        expectedState: pending,
        document: tokenizer.tokenizeDocument(source.body),
      }).state);
      expect(pending.slotDocumentCount).toBe(2);
      expect(corpus(opened.db)).toEqual({ documents: 0, tokens: 0 });

      const beforeActivation = changes(opened.db);
      const repaired = requireState(activateChat(opened.db, { expectedState: pending }).state);
      expect(changes(opened.db) - beforeActivation).toBe(2);
      expect(repaired.status).toBe('indexed');
      expect(corpus(opened.db)).toEqual({ documents: 2, tokens: 8 });
      expect(planAppend(opened.db, {
        chatId: repaired.chatId,
        transcriptViewId: repaired.transcriptViewId,
        expectedAfterOrdinal: 1,
        targetThrough: 1,
      }).disposition).toBe('current');
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('resumes one durable term cursor and finalizes zero-native chunks', async () => {
    const { dbPath, tokenizer } = await fixture();
    let opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      const body = Array.from({ length: 70 }, (_, index) => `term${String(index).padStart(3, '0')}`)
        .join(' ');
      const plan = planReplacement(opened.db, {
        chatId: 'cursor-chat',
        transcriptViewId: 'cursor-view',
        targetThrough: 1,
      });
      const batch = tokenizer.tokenizeDocuments([body]);
      let current = requireState(stageRawChunks(opened.db, {
        expectedState: plan.state,
        rows: [{ ordinal: 1, role: 'user', timestamp: null, body }],
        documents: batch.documents,
      }).state);
      const source = readActiveChunkBody(opened.db, current);
      if (source.disposition !== 'current') throw new Error('test expected source');
      const first = buildTermStep(opened.db, {
        expectedState: current,
        document: tokenizer.tokenizeDocument(source.body),
      });
      expect(first).toMatchObject({
        disposition: 'term-progress',
        insertedTerms: 32,
        completedChunk: false,
      });
      expect(opened.db.query(`
        SELECT persisted_term_count AS count FROM search_chunk_progress
      `).get()).toEqual({ count: 32 });
      closeSearchDatabase(opened.db);

      opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
      expect(opened.recreated).toBe(false);
      current = getChatState(opened.db, 'cursor-chat')!;
      while (current.activeChunkId !== null) {
        const active = readActiveChunkBody(opened.db, current);
        if (active.disposition !== 'current') throw new Error('test expected source');
        current = requireState(buildTermStep(opened.db, {
          expectedState: current,
          document: tokenizer.tokenizeDocument(active.body),
        }).state);
      }
      expect(current).toMatchObject({ processedThrough: 1, slotDocumentCount: 1 });

      const zeroPlan = planReplacement(opened.db, {
        chatId: 'zero-chat',
        transcriptViewId: 'zero-view',
        targetThrough: 1,
      });
      const zeroBatch = tokenizer.tokenizeDocuments(['_']);
      let zero = requireState(stageRawChunks(opened.db, {
        expectedState: zeroPlan.state,
        rows: [{ ordinal: 1, role: 'system', timestamp: null, body: '_' }],
        documents: zeroBatch.documents,
      }).state);
      const zeroSource = readActiveChunkBody(opened.db, zero);
      if (zeroSource.disposition !== 'current') throw new Error('test expected source');
      const zeroResult = buildTermStep(opened.db, {
        expectedState: zero,
        document: tokenizer.tokenizeDocument(zeroSource.body),
      });
      expect(zeroResult).toMatchObject({
        insertedTerms: 0,
        insertedOccurrences: 0,
        completedChunk: true,
      });
      zero = requireState(zeroResult.state);
      expect(zero).toMatchObject({ processedThrough: 1, activeChunkId: null });
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('rejects an unexpected persisted successor before advancing the durable cursor', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      const body = Array.from({ length: 70 }, (_, index) => `native${String(index).padStart(3, '0')}`)
        .join(' ');
      const plan = planReplacement(opened.db, {
        chatId: 'successor-chat',
        transcriptViewId: 'successor-view',
        targetThrough: 1,
      });
      const batch = tokenizer.tokenizeDocuments([body]);
      const staged = requireState(stageRawChunks(opened.db, {
        expectedState: plan.state,
        rows: [{ ordinal: 1, role: 'user', timestamp: null, body }],
        documents: batch.documents,
      }).state);
      const source = readActiveChunkBody(opened.db, staged);
      if (source.disposition !== 'current') throw new Error('test expected source');
      const document = tokenizer.tokenizeDocument(source.body);
      const first = buildTermStep(opened.db, { expectedState: staged, document });
      expect(first).toMatchObject({ insertedTerms: 32, completedChunk: false });
      const durableState = requireState(first.state);
      opened.db.query(`
        INSERT INTO search_chunk_terms(chunk_id, chat_id, term, frequency, positions)
        VALUES (?, ?, ?, 1, ?)
      `).run(
        durableState.activeChunkId,
        durableState.chatId,
        Buffer.from('zzzz-unexpected-successor'),
        Uint8Array.of(1),
      );
      const before = changes(opened.db);
      expect(() => buildTermStep(opened.db, {
        expectedState: durableState,
        document,
      })).toThrow('SEARCH_INDEX_CORRUPT');
      expect(changes(opened.db)).toBe(before);
      expect(getChatState(opened.db, durableState.chatId)).toEqual(durableState);

      const greatestOpcodes = opened.db.query<{ opcode: string }, [number]>(
        `EXPLAIN ${SEARCH_GREATEST_PERSISTED_POSTING_SQL}`,
      ).all(durableState.activeChunkId!).map((entry) => entry.opcode);
      const successorOpcodes = opened.db.query<{ opcode: string }, [number, Uint8Array]>(
        `EXPLAIN ${SEARCH_PERSISTED_SUCCESSOR_SQL}`,
      ).all(durableState.activeChunkId!, Buffer.from('native069'))
        .map((entry) => entry.opcode);
      expect(greatestOpcodes).toContain('SeekLE');
      expect(successorOpcodes).toContain('SeekGT');
      expect(successorOpcodes).not.toContain('Rewind');
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('classifies malformed durable cleanup postings as derived-index corruption', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      const initial = planReplacement(opened.db, {
        chatId: 'cleanup-corruption-chat',
        transcriptViewId: 'cleanup-corruption-view-1',
        targetThrough: 1,
      });
      const indexed = completeBuild(opened.db, tokenizer, initial.state, [{
        ordinal: 1,
        role: 'user',
        timestamp: null,
        body: 'synthetic alpha beta gamma',
      }]);
      const replacement = planReplacement(opened.db, {
        chatId: indexed.chatId,
        transcriptViewId: 'cleanup-corruption-view-2',
        targetThrough: 1,
      });
      expect(replacement.disposition).toBe('cleanup');
      const chunkId = replacement.state.activeChunkId!;
      const greatest = opened.db.query<{ term: Uint8Array }, [number]>(
        SEARCH_GREATEST_PERSISTED_POSTING_SQL,
      ).get(chunkId)!;
      opened.db.query(`
        UPDATE search_chunk_terms SET positions = ? WHERE chunk_id = ? AND term = ?
      `).run(Uint8Array.of(0), chunkId, greatest.term);

      const before = changes(opened.db);
      expect(() => cleanupStep(opened.db, { expectedState: replacement.state }))
        .toThrow('SEARCH_INDEX_CORRUPT');
      expect(changes(opened.db)).toBe(before);
      expect(getChatState(opened.db, indexed.chatId)).toEqual(replacement.state);
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('publishes next active chunks atomically and securely retires replacement rows', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    const marker = 'synthetic-secure-retirement-marker';
    try {
      const plan = planReplacement(opened.db, {
        chatId: 'replacement-chat',
        transcriptViewId: 'old-view',
        targetThrough: 2,
      });
      const rows: HistoricalSearchMessageRow[] = [
        { ordinal: 1, role: 'user', timestamp: null, body: `${marker} first` },
        { ordinal: 2, role: 'assistant', timestamp: null, body: 'synthetic second row' },
      ];
      const batch = tokenizer.tokenizeDocuments(rows.map((row) => row.body));
      let current = requireState(stageRawChunks(opened.db, {
        expectedState: plan.state,
        rows,
        documents: batch.documents,
      }).state);
      const firstSource = readActiveChunkBody(opened.db, current);
      if (firstSource.disposition !== 'current') throw new Error('test expected source');
      current = requireState(buildTermStep(opened.db, {
        expectedState: current,
        document: tokenizer.tokenizeDocument(firstSource.body),
      }).state);
      const secondConnection = openSearchReadDatabase(dbPath, {
        tokenizerFingerprint: tokenizer.fingerprint,
      });
      try {
        expect(secondConnection.query(`
          SELECT active_chunk_id AS active FROM search_chat_state
          WHERE chat_id = 'replacement-chat'
        `).get()).toEqual({ active: 2 });
      } finally {
        secondConnection.close();
      }
      while (current.activeChunkId !== null) {
        const source = readActiveChunkBody(opened.db, current);
        if (source.disposition !== 'current') throw new Error('test expected source');
        current = requireState(buildTermStep(opened.db, {
          expectedState: current,
          document: tokenizer.tokenizeDocument(source.body),
        }).state);
      }
      current = requireState(activateChat(opened.db, { expectedState: current }).state);

      const replacement = planReplacement(opened.db, {
        chatId: current.chatId,
        transcriptViewId: 'new-view',
        targetThrough: 0,
      });
      current = replacement.state;
      let sawRawDeleteNext = false;
      while (current.phase === 'replacement-cleanup') {
        const result = cleanupStep(opened.db, { expectedState: current });
        if (result.disposition === 'cleanup-progress') {
          current = result.state;
          if (result.deletedRows === 1 && current.activeChunkId !== null) {
            sawRawDeleteNext = true;
          }
          continue;
        }
        if (result.disposition !== 'replacement-checkpoint') {
          throw new Error('test expected replacement checkpoint');
        }
        current = result.state;
      }
      expect(sawRawDeleteNext).toBe(true);
      const checkpoint = truncateWal(opened.db);
      expect(checkpoint).toEqual({ busy: 0, logFrames: 0, checkpointedFrames: 0 });
      expect((await readFile(dbPath)).includes(Buffer.from(marker))).toBe(false);
      const resumed = completeReplacementCheckpoint(opened.db, { expectedState: current });
      expect(resumed).toMatchObject({ disposition: 'build', state: { phase: 'replacement-build' } });
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('aggregates prune population subtraction into one production singleton update', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      for (let index = 0; index < 16; index += 1) {
        const chatId = `prune-chat-${String(index).padStart(2, '0')}`;
        const plan = planReplacement(opened.db, {
          chatId,
          transcriptViewId: `view-${index}`,
          targetThrough: 1,
        });
        completeBuild(opened.db, tokenizer, plan.state, [{
          ordinal: 1,
          role: 'user',
          timestamp: null,
          body: `synthetic prune row ${index}`,
        }]);
      }
      expect(corpus(opened.db).documents).toBe(16);
      const before = changes(opened.db);
      const result = markPrunedChats(opened.db, { allowedChatIds: [], afterChatId: null });
      expect(result.cleanups).toHaveLength(16);
      expect(changes(opened.db) - before).toBe(17);
      expect(corpus(opened.db)).toEqual({ documents: 0, tokens: 0 });

      const opcodes = opened.db.query<{ opcode: string }, [number, number, number, number]>(
        `EXPLAIN ${SEARCH_PRUNE_CORPUS_SUBTRACT_SQL}`,
      ).all(1, 1, 1, 1).map((entry) => entry.opcode);
      expect(opcodes.filter((opcode) => opcode === 'OpenWrite')).toHaveLength(1);
      expect(opcodes).not.toContain('SorterOpen');
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('uses the durable active cursor and bounded address-index seeks on a mature slot', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      const plan = planReplacement(opened.db, {
        chatId: 'mature-chat',
        transcriptViewId: 'target-view',
        targetThrough: 1_024,
      });
      opened.db.exec('BEGIN IMMEDIATE');
      try {
        const insertChunk = opened.db.query(`
          INSERT INTO search_chunks(
            chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
            token_count, term_count, term_bytes, position_bytes
          ) VALUES ('mature-chat', 'physical-view', ?, 0, NULL, '_', 1, 1, 0, 0, 0)
          RETURNING id
        `);
        const insertProgress = opened.db.query(`
          INSERT INTO search_chunk_progress VALUES (?, 1, 0, 0, 0, 0, NULL)
        `);
        let firstId = 0;
        for (let ordinal = 1; ordinal <= 1_024; ordinal += 1) {
          const id = Number((insertChunk.get(ordinal) as { id: number }).id);
          firstId ||= id;
          insertProgress.run(id);
        }
        opened.db.query(`
          UPDATE search_chat_state
          SET phase = 'replacement-cleanup', active_chunk_id = ?,
            slot_document_count = 1024, slot_token_count = 1024
          WHERE chat_id = 'mature-chat'
        `).run(firstId);
        opened.db.exec('COMMIT');
      } catch (error) {
        opened.db.exec('ROLLBACK');
        throw error;
      }

      const expectedState = getChatState(opened.db, plan.state.chatId)!;
      const result = cleanupStep(opened.db, { expectedState });
      expect(result).toMatchObject({
        disposition: 'cleanup-progress',
        deletedRows: 16,
        deletedTerms: 0,
        state: { slotDocumentCount: 1_008, slotTokenCount: 1_008 },
      });
      expect(opened.db.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM search_chunks WHERE chat_id = 'mature-chat'
      `).get()).toEqual({ count: 1_008 });

      const statements: ReadonlyArray<{
        readonly sql: string;
        readonly bindings: readonly (string | number)[];
        readonly requiredPlan: RegExp;
        readonly maximumRows: number;
      }> = [
        {
          sql: SEARCH_FIRST_SLOT_CHUNK_SQL,
          bindings: ['mature-chat'],
          requiredPlan: /COVERING INDEX sqlite_autoindex_search_chunks_1 \(chat_id=\?\)/,
          maximumRows: 1,
        },
        {
          sql: SEARCH_NEXT_VIEW_CHUNK_SQL,
          bindings: ['mature-chat', 'physical-view', 16],
          requiredPlan: /COVERING INDEX sqlite_autoindex_search_chunks_1 .*ordinal>\?/,
          maximumRows: 1,
        },
        {
          sql: SEARCH_RAW_DELETE_CANDIDATES_SQL,
          bindings: ['mature-chat', 'physical-view', 17],
          requiredPlan: /INDEX sqlite_autoindex_search_chunks_1 .*ordinal>\?/,
          maximumRows: 16,
        },
        {
          sql: SEARCH_CHUNK_HAS_TERMS_SQL,
          bindings: [17],
          requiredPlan: /SEARCH search_chunk_terms USING PRIMARY KEY \(chunk_id=\?\)/,
          maximumRows: 1,
        },
      ];
      for (const statement of statements) {
        const planDetails = opened.db.query<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${statement.sql}`,
        ).all(...statement.bindings).map((entry) => entry.detail).join('\n');
        const opcodes = opened.db.query<{ opcode: string }>(
          `EXPLAIN ${statement.sql}`,
        ).all(...statement.bindings).map((entry) => entry.opcode);
        expect(planDetails).toMatch(statement.requiredPlan);
        expect(planDetails).not.toMatch(/USE TEMP B-TREE/);
        expect(opcodes).not.toContain('Rewind');
        expect(opened.db.query(statement.sql).all(...statement.bindings).length)
          .toBeLessThanOrEqual(statement.maximumRows);
      }
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });

  it('rejects cap-plus-one inputs before a transaction or WAL change', async () => {
    const { dbPath, tokenizer } = await fixture();
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    try {
      const plan = planReplacement(opened.db, {
        chatId: 'bounded-chat',
        transcriptViewId: 'bounded-view',
        targetThrough: 20,
      });
      const beforeChanges = changes(opened.db);
      const beforeWal = observeWal(opened.db);
      expect(() => planReplacement(opened.db, {
        chatId: 'x'.repeat(257),
        transcriptViewId: 'bounded-view',
        targetThrough: 1,
      })).toThrow('SEARCH_IDENTIFIER_INVALID');

      const document: TokenizedDocument = {
        document: 1,
        tokenCount: 1,
        termCount: 0,
        termBytes: 0,
        positionBytes: 0,
        postings: [],
      };
      const seventeenRows = Array.from({ length: 17 }, (_, index) => ({
        ordinal: index + 1,
        role: 'user' as const,
        timestamp: null,
        body: '_',
      }));
      expect(() => stageRawChunks(opened.db, {
        expectedState: plan.state,
        rows: seventeenRows,
        documents: seventeenRows.map((_, index) => ({ ...document, document: index + 1 })),
      })).toThrow('SEARCH_RAW_STAGE_INVALID');

      const largeBody = '😀'.repeat(32_000);
      const nineRows = Array.from({ length: 9 }, (_, index) => ({
        ordinal: index + 1,
        role: 'user' as const,
        timestamp: null,
        body: largeBody,
      }));
      expect(() => stageRawChunks(opened.db, {
        expectedState: plan.state,
        rows: nineRows,
        documents: nineRows.map((_, index) => ({ ...document, document: index + 1 })),
      })).toThrow('SEARCH_RAW_STAGE_INVALID');
      expect(changes(opened.db)).toBe(beforeChanges);
      expect(observeWal(opened.db)).toEqual(beforeWal);
    } finally {
      closeSearchDatabase(opened.db);
      tokenizer.close();
    }
  });
});
