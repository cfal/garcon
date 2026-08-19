import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { HistoricalSearchMessageRow } from '../server-agents/common/src/search/rows.js';
import {
  SEARCH_CHUNK_HAS_TERMS_SQL,
  SEARCH_FIRST_SLOT_CHUNK_SQL,
  SEARCH_GREATEST_PERSISTED_POSTING_SQL,
  SEARCH_INDEXER_CACHE_SIZE_PAGES,
  SEARCH_INDEXER_MAX_STEP_RSS_DELTA_BYTES,
  SEARCH_INDEX_PAGE_SIZE,
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_MAX_WAL_BYTES,
  SEARCH_NEXT_VIEW_CHUNK_SQL,
  SEARCH_PERSISTED_SUCCESSOR_SQL,
  SEARCH_PRUNE_CORPUS_SUBTRACT_SQL,
  SEARCH_RAW_DELETE_CANDIDATES_SQL,
  SEARCH_SCHEMA_SQL_SHA256,
  SEARCH_TERM_STEP_MAX_BYTES,
  SEARCH_TERM_STEP_MAX_ROWS,
  SEARCH_WAL_HIGH_WATER_FRAMES,
  activateChat,
  advanceFrontier,
  buildTermStep,
  cleanupStep,
  closeSearchDatabase,
  getChatState,
  markChatFailed,
  markPrunedChats,
  observeWal,
  openSearchDatabase,
  planAppend,
  planReplacement,
  readActiveChunkBody,
  stageRawChunks,
  startRemoval,
  truncateWal,
  type SearchChatState,
} from '../server-agents/common/src/search/schema.js';
import {
  SEARCH_APPROVED_FTS5_SOURCE_ID,
  SearchTokenizer,
  encodeCanonicalPositions,
  type TokenizedDocument,
} from '../server-agents/common/src/search/tokenizer.js';
import { runTranscriptSearchV8RssProof } from './transcript-search-v8-rss-driver.js';

export const TRANSCRIPT_SEARCH_V8_PROOF_BUN_VERSION = '1.4.0';
export const TRANSCRIPT_SEARCH_V8_PROOF_SQLITE_VERSION = '3.53.2';

export const TRANSCRIPT_SEARCH_V8_PROOF_SHAPES = [
  'empty',
  'mature-ascending',
  'mature-interleaved',
  'mature-descending',
  'fragmented',
] as const;

export const TRANSCRIPT_SEARCH_V8_PROOF_OPERATIONS = [
  'term-build-nonfinal',
  'term-build-final-next',
  'cleanup-first-remainder',
  'cleanup-later',
  'zero-term-final-next',
  'raw-stage',
  'raw-delete-next',
  'activation',
  'indexed-to-pending',
  'prune-16',
  'frontier',
  'failure',
  'replacement-checkpoint',
  'state-removal',
  'current',
  'superseded',
] as const;

export const TRANSCRIPT_SEARCH_V8_RSS_OPERATIONS = [
  'term-build-final-next',
  'cleanup-first-remainder',
  'raw-stage',
  'raw-delete-next',
  'activation',
  'prune-16',
] as const;

export const TRANSCRIPT_SEARCH_V8_RSS_SHAPES = [
  'empty',
  'mature-interleaved',
  'fragmented',
] as const;

type ProofShape = typeof TRANSCRIPT_SEARCH_V8_PROOF_SHAPES[number];
type ProofOperation = typeof TRANSCRIPT_SEARCH_V8_PROOF_OPERATIONS[number];

const OPERATION_FRAME_LIMITS: Readonly<Record<ProofOperation, number>> = {
  'term-build-nonfinal': 24_975,
  'term-build-final-next': 26_429,
  'cleanup-first-remainder': 49_829,
  'cleanup-later': 48_015,
  'zero-term-final-next': 2_543,
  'raw-stage': 20_209,
  'raw-delete-next': 36_401,
  activation: 2_179,
  'indexed-to-pending': 2_179,
  'prune-16': 18_509,
  frontier: 1_091,
  failure: 1_091,
  'replacement-checkpoint': 1_091,
  'state-removal': 727,
  current: 0,
  superseded: 0,
};

interface ProofContext {
  readonly db: Database;
  readonly dbPath: string;
  readonly tokenizer: SearchTokenizer;
  readonly shape: ProofShape;
  readonly operation: ProofOperation;
}

interface MutationMeasurement {
  readonly operation: ProofOperation;
  readonly shape: ProofShape;
  readonly frames: number;
  readonly checkpointedFrames: number;
  readonly totalChanges: number;
  readonly rssBefore: number;
  readonly rssAfter: number;
  readonly hwmBefore: number;
  readonly hwmAfter: number;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function state(value: SearchChatState | undefined): SearchChatState {
  invariant(value, 'SEARCH_PROOF_STATE_MISSING');
  return value;
}

function totalChanges(db: Database): number {
  return Number(db.query<{ value: number }, []>('SELECT total_changes() AS value').get()?.value);
}

function pragmaNumber(db: Database, sql: string): number {
  const row = db.query<Record<string, number>, []>(sql).get();
  const value = row ? Object.values(row)[0] : undefined;
  invariant(Number.isSafeInteger(value), `SEARCH_PROOF_PRAGMA:${sql}`);
  return value;
}

function processStatus(field: 'VmRSS' | 'VmHWM'): number {
  const match = readFileSync('/proc/self/status', 'utf8')
    .match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm'));
  invariant(match, `SEARCH_PROOF_${field.toUpperCase()}_MISSING`);
  return Number(match[1]) * 1_024;
}

function schemaSqlHash(db: Database): string {
  const rows = db.query<{
    type: string;
    name: string;
    tableName: string;
    sql: string;
  }, []>(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  const payload = rows.map((row) => (
    `${row.type}\0${row.name}\0${row.tableName}\0${row.sql}`
  )).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

function verifyRuntimeIdentity(db: Database, tokenizer: SearchTokenizer): Record<string, unknown> {
  const runtime = db.query<{
    sqliteVersion: string;
    sourceId: string;
  }, []>(`
    SELECT sqlite_version() AS sqliteVersion, fts5_source_id() AS sourceId
  `).get();
  invariant(Bun.version === TRANSCRIPT_SEARCH_V8_PROOF_BUN_VERSION, 'SEARCH_PROOF_BUN_VERSION');
  invariant(runtime?.sqliteVersion === TRANSCRIPT_SEARCH_V8_PROOF_SQLITE_VERSION,
    'SEARCH_PROOF_SQLITE_VERSION');
  invariant(runtime.sourceId === SEARCH_APPROVED_FTS5_SOURCE_ID, 'SEARCH_PROOF_FTS_SOURCE');
  invariant(tokenizer.sourceId === SEARCH_APPROVED_FTS5_SOURCE_ID, 'SEARCH_PROOF_TOKENIZER_SOURCE');
  invariant(schemaSqlHash(db) === SEARCH_SCHEMA_SQL_SHA256, 'SEARCH_PROOF_SCHEMA_HASH');
  invariant(pragmaNumber(db, 'PRAGMA page_size') === SEARCH_INDEX_PAGE_SIZE,
    'SEARCH_PROOF_PAGE_SIZE');
  invariant(pragmaNumber(db, 'PRAGMA auto_vacuum') === 0, 'SEARCH_PROOF_AUTO_VACUUM');
  invariant(pragmaNumber(db, 'PRAGMA cache_size') === SEARCH_INDEXER_CACHE_SIZE_PAGES,
    'SEARCH_PROOF_CACHE_SIZE');
  return {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    sqliteVersion: runtime.sqliteVersion,
    sourceId: runtime.sourceId,
    schemaSqlSha256: SEARCH_SCHEMA_SQL_SHA256,
  };
}

function proofIdentifier(prefix: string, marker: string): string {
  return `${prefix}-${marker}-`.padEnd(256, marker.at(-1) ?? 'x').slice(0, 256);
}

function row(ordinal: number, body: string): HistoricalSearchMessageRow {
  return {
    ordinal,
    role: 'user',
    timestamp: 't'.repeat(256),
    body,
  };
}

function fullTermBatchLengths(cursorLength: 32_767 | 32_768): number[] {
  const remaining = SEARCH_TERM_STEP_MAX_BYTES - SEARCH_TERM_STEP_MAX_ROWS - cursorLength;
  const base = Math.floor(remaining / (SEARCH_TERM_STEP_MAX_ROWS - 1));
  const remainder = remaining - base * (SEARCH_TERM_STEP_MAX_ROWS - 1);
  return [
    ...Array.from(
      { length: SEARCH_TERM_STEP_MAX_ROWS - 1 },
      (_, index) => base + (index < remainder ? 1 : 0),
    ),
    cursorLength,
  ];
}

function syntheticTermDocument(input: {
  readonly leadingSmall?: boolean;
  readonly trailingSmall?: boolean;
  readonly cursorLengths: readonly (32_767 | 32_768)[];
}): TokenizedDocument {
  const lengths = [
    ...(input.leadingSmall ? [8] : []),
    ...input.cursorLengths.flatMap((length) => fullTermBatchLengths(length)),
    ...(input.trailingSmall ? [8] : []),
  ];
  const postings = lengths.map((length, index) => {
    const prefix = Buffer.from(`t${index.toString().padStart(3, '0')}`);
    invariant(prefix.byteLength <= length, 'SEARCH_PROOF_TERM_PREFIX');
    const term = Buffer.alloc(length, 0x78);
    term.set(prefix);
    return {
      term,
      frequency: 1,
      positions: encodeCanonicalPositions([index]),
    };
  });
  const termBytes = postings.reduce((total, posting) => total + posting.term.byteLength, 0);
  const positionBytes = postings.reduce(
    (total, posting) => total + posting.positions.byteLength,
    0,
  );
  invariant(termBytes <= 1_048_576, 'SEARCH_PROOF_TERM_AGGREGATE');
  invariant(positionBytes <= 524_288, 'SEARCH_PROOF_POSITION_AGGREGATE');
  return {
    document: 1,
    tokenCount: postings.length + 1,
    termCount: postings.length,
    termBytes,
    positionBytes,
    postings,
  };
}

function rawBodies(count: number): string[] {
  const totalCodeUnits = Math.floor((1_048_576 - count) / 3);
  const base = Math.floor(totalCodeUnits / count);
  let remaining = totalCodeUnits - base * count;
  return Array.from({ length: count }, () => {
    const length = base + (remaining > 0 ? 1 : 0);
    remaining = Math.max(0, remaining - 1);
    return '\u2014'.repeat(length);
  });
}

function plan(
  context: ProofContext,
  suffix: string,
  targetThrough: number,
): SearchChatState {
  return planReplacement(context.db, {
    chatId: proofIdentifier(`z-${context.operation}-${suffix}`, 'c'),
    transcriptViewId: proofIdentifier(`v-${context.shape}-${suffix}`, 'v'),
    targetThrough,
  }).state;
}

function stage(
  context: ProofContext,
  expectedState: SearchChatState,
  rows: readonly HistoricalSearchMessageRow[],
): SearchChatState {
  const batch = context.tokenizer.tokenizeDocuments(rows.map((entry) => entry.body));
  invariant(batch.acceptedDocumentCount === rows.length, 'SEARCH_PROOF_TOKENIZER_PREFIX');
  return state(stageRawChunks(context.db, {
    expectedState,
    rows,
    documents: batch.documents,
  }).state);
}

function stageDocuments(
  context: ProofContext,
  expectedState: SearchChatState,
  rows: readonly HistoricalSearchMessageRow[],
  documents: readonly TokenizedDocument[],
): SearchChatState {
  return state(stageRawChunks(context.db, { expectedState, rows, documents }).state);
}

function buildDocument(
  context: ProofContext,
  expectedState: SearchChatState,
  document: TokenizedDocument,
): SearchChatState {
  return state(buildTermStep(context.db, { expectedState, document }).state);
}

function buildActive(context: ProofContext, expectedState: SearchChatState): SearchChatState {
  const source = readActiveChunkBody(context.db, expectedState);
  invariant(source.disposition === 'current', 'SEARCH_PROOF_ACTIVE_BODY');
  return state(buildTermStep(context.db, {
    expectedState,
    document: context.tokenizer.tokenizeDocument(source.body),
  }).state);
}

function buildAll(context: ProofContext, expectedState: SearchChatState): SearchChatState {
  let current = expectedState;
  while (current.activeChunkId !== null) current = buildActive(context, current);
  return current;
}

function indexSyntheticDocument(
  context: ProofContext,
  suffix: string,
  document: TokenizedDocument,
): SearchChatState {
  let current = stageDocuments(
    context,
    plan(context, suffix, 1),
    [row(1, 'synthetic bounded posting fixture')],
    [document],
  );
  while (current.activeChunkId !== null) current = buildDocument(context, current, document);
  return state(activateChat(context.db, { expectedState: current }).state);
}

function indexRows(
  context: ProofContext,
  suffix: string,
  rows: readonly HistoricalSearchMessageRow[],
): SearchChatState {
  let current = plan(context, suffix, rows.at(-1)?.ordinal ?? 0);
  let offset = 0;
  while (offset < rows.length) {
    const selected = rows.slice(offset, offset + 16);
    current = stage(context, current, selected);
    current = buildAll(context, current);
    offset += selected.length;
  }
  if (current.processedThrough < current.targetThrough) {
    current = state(advanceFrontier(context.db, {
      expectedState: current,
      throughOrdinal: current.targetThrough,
    }).state);
  }
  return state(activateChat(context.db, { expectedState: current }).state);
}

function transaction(db: Database, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function shapeOrder(shape: Exclude<ProofShape, 'empty' | 'fragmented'>, count: number): number[] {
  const ascending = Array.from({ length: count }, (_, index) => index);
  if (shape === 'mature-ascending') return ascending;
  if (shape === 'mature-descending') return ascending.reverse();
  return [
    ...ascending.filter((value) => value % 2 === 0),
    ...ascending.filter((value) => value % 2 === 1).reverse(),
  ];
}

function seedShape(db: Database, shape: ProofShape): void {
  if (shape === 'empty') return;
  const count = shape === 'fragmented' ? 1_536 : 1_024;
  const order = shape === 'fragmented'
    ? Array.from({ length: count }, (_, index) => index)
    : shapeOrder(shape, count);
  const inserted = new Map<number, { chatId: string; chunkId: number }>();
  transaction(db, () => {
    const insertState = db.query(`
      INSERT INTO search_chat_state(
        chat_id, transcript_view_id, status, phase, target_through,
        processed_through, active_chunk_id, slot_document_count,
        slot_token_count, last_error_code, updated_at
      ) VALUES (?, ?, 'indexed', 'idle', 1, 1, NULL, 1, 2, NULL, ?)
    `);
    const insertChunk = db.query(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
        token_count, term_count, term_bytes, position_bytes
      ) VALUES (?, ?, 1, 0, NULL, ?, ?, 2, 1, ?, 1) RETURNING id
    `);
    const insertProgress = db.query(`
      INSERT INTO search_chunk_progress(
        chunk_id, complete, persisted_term_count, persisted_occurrence_count,
        persisted_term_bytes, persisted_position_bytes, term_cursor
      ) VALUES (?, 1, 1, 1, ?, 1, ?)
    `);
    const insertTerm = db.query(`
      INSERT INTO search_chunk_terms(chunk_id, chat_id, term, frequency, positions)
      VALUES (?, ?, ?, 1, ?)
    `);
    for (const index of order) {
      const chatId = `a-seed-${index.toString().padStart(6, '0')}`;
      const viewId = `a-view-${index.toString().padStart(6, '0')}`;
      const term = Buffer.from(`seed${index.toString().padStart(6, '0')}`);
      insertState.run(chatId, viewId, '2026-08-19T00:00:00.000Z');
      const chunkId = Number((insertChunk.get(
        chatId,
        viewId,
        term.toString(),
        term.byteLength,
        term.byteLength,
      ) as { id: number }).id);
      insertProgress.run(chunkId, term.byteLength, term);
      insertTerm.run(chunkId, chatId, term, Buffer.from([1]));
      inserted.set(index, { chatId, chunkId });
    }
    db.query(`
      UPDATE search_corpus_stats SET document_count = ?, total_token_count = ?
      WHERE singleton = 1
    `).run(count, count * 2);
  });
  if (shape === 'fragmented') {
    let removed = 0;
    transaction(db, () => {
      const deleteTerm = db.query('DELETE FROM search_chunk_terms WHERE chunk_id = ?');
      const deleteProgress = db.query('DELETE FROM search_chunk_progress WHERE chunk_id = ?');
      const deleteChunk = db.query('DELETE FROM search_chunks WHERE id = ?');
      const deleteState = db.query('DELETE FROM search_chat_state WHERE chat_id = ?');
      for (const [index, entry] of inserted) {
        if (index % 3 !== 1) continue;
        deleteTerm.run(entry.chunkId);
        deleteProgress.run(entry.chunkId);
        deleteChunk.run(entry.chunkId);
        deleteState.run(entry.chatId);
        removed += 1;
      }
      db.query(`
        UPDATE search_corpus_stats SET document_count = ?, total_token_count = ?
        WHERE singleton = 1
      `).run(count - removed, (count - removed) * 2);
    });
  }
  const checkpoint = truncateWal(db);
  invariant(checkpoint.busy === 0 && checkpoint.logFrames === 0, 'SEARCH_PROOF_SHAPE_TRUNCATE');
}

function measureMutation(
  context: ProofContext,
  work: () => unknown,
): MutationMeasurement {
  const truncated = truncateWal(context.db);
  invariant(truncated.busy === 0 && truncated.logFrames === 0, 'SEARCH_PROOF_PRE_TRUNCATE');
  const changesBefore = totalChanges(context.db);
  const rssBefore = process.memoryUsage.rss();
  const hwmBefore = processStatus('VmHWM');
  work();
  const observation = observeWal(context.db);
  const rssAfter = process.memoryUsage.rss();
  const hwmAfter = processStatus('VmHWM');
  const totalChangeDelta = totalChanges(context.db) - changesBefore;
  const limit = OPERATION_FRAME_LIMITS[context.operation];
  invariant(observation.logFrames <= limit,
    `SEARCH_PROOF_FRAME_BOUND:${context.operation}:${observation.logFrames}:${limit}`);
  invariant(observation.logFrames <= SEARCH_MAX_DIRTY_FRAMES, 'SEARCH_PROOF_F_BOUND');
  if (limit === 0) {
    invariant(observation.logFrames === 0 && totalChangeDelta === 0,
      `SEARCH_PROOF_ZERO_DML:${context.operation}`);
  }
  return {
    operation: context.operation,
    shape: context.shape,
    frames: observation.logFrames,
    checkpointedFrames: observation.checkpointedFrames,
    totalChanges: totalChangeDelta,
    rssBefore,
    rssAfter,
    hwmBefore,
    hwmAfter,
  };
}

function executeScenario(context: ProofContext): MutationMeasurement {
  switch (context.operation) {
    case 'term-build-nonfinal': {
      const document = syntheticTermDocument({
        cursorLengths: [32_768, 32_768],
        trailingSmall: true,
      });
      const current = stageDocuments(
        context,
        plan(context, 'term-nonfinal', 1),
        [row(1, 'synthetic nonfinal posting fixture')],
        [document],
      );
      return measureMutation(context, () => {
        const result = buildTermStep(context.db, { expectedState: current, document });
        invariant(result.disposition === 'term-progress'
          && result.insertedTerms === SEARCH_TERM_STEP_MAX_ROWS
          && !result.completedChunk, 'SEARCH_PROOF_TERM_NONFINAL_RESULT');
      });
    }
    case 'term-build-final-next': {
      const document = syntheticTermDocument({ cursorLengths: [32_767, 32_768] });
      const empty = context.tokenizer.tokenizeDocument('_');
      let current = stageDocuments(context, plan(context, 'term-final', 2), [
        row(1, 'synthetic final posting fixture'),
        row(2, '_'),
      ], [document, { ...empty, document: 2 }]);
      const first = buildTermStep(context.db, { expectedState: current, document });
      invariant(first.disposition === 'term-progress'
        && first.insertedTerms === SEARCH_TERM_STEP_MAX_ROWS
        && !first.completedChunk, 'SEARCH_PROOF_TERM_FIRST_RESULT');
      current = first.state;
      return measureMutation(context, () => {
        const result = buildTermStep(context.db, { expectedState: current, document });
        invariant(result.disposition === 'term-progress'
          && result.insertedTerms === SEARCH_TERM_STEP_MAX_ROWS
          && result.completedChunk
          && result.state.activeChunkId !== null, 'SEARCH_PROOF_TERM_FINAL_RESULT');
      });
    }
    case 'cleanup-first-remainder':
    case 'cleanup-later': {
      const document = syntheticTermDocument({
        leadingSmall: true,
        cursorLengths: [32_767, 32_768],
      });
      const indexed = indexSyntheticDocument(context, 'cleanup', document);
      let current = state(startRemoval(context.db, indexed.chatId).state);
      if (context.operation === 'cleanup-later') {
        const first = cleanupStep(context.db, { expectedState: current });
        invariant(first.disposition === 'cleanup-progress', 'SEARCH_PROOF_FIRST_CLEANUP');
        current = first.state;
      }
      return measureMutation(context, () => {
        const result = cleanupStep(context.db, { expectedState: current });
        invariant(result.disposition === 'cleanup-progress'
          && result.deletedTerms === SEARCH_TERM_STEP_MAX_ROWS
          && result.deletedRows === 0, 'SEARCH_PROOF_TERM_CLEANUP_RESULT');
      });
    }
    case 'zero-term-final-next': {
      const current = stage(context, plan(context, 'zero-final', 2), [row(1, '_'), row(2, '_')]);
      return measureMutation(context, () => {
        const result = buildTermStep(context.db, {
          expectedState: current,
          document: context.tokenizer.tokenizeDocument('_'),
        });
        invariant(result.disposition === 'term-progress'
          && result.insertedTerms === 0
          && result.completedChunk
          && result.state.activeChunkId !== null, 'SEARCH_PROOF_ZERO_TERM_RESULT');
      });
    }
    case 'raw-stage': {
      const current = plan(context, 'raw-stage', 16);
      const rows = rawBodies(16).map((body, index) => row(index + 1, body));
      const batch = context.tokenizer.tokenizeDocuments(rows.map((entry) => entry.body));
      invariant(batch.acceptedDocumentCount === rows.length, 'SEARCH_PROOF_RAW_PREFIX');
      return measureMutation(context, () => {
        const result = stageRawChunks(context.db, {
          expectedState: current,
          rows,
          documents: batch.documents,
        });
        invariant(result.disposition === 'raw-staged'
          && result.acceptedRows === 16, 'SEARCH_PROOF_RAW_STAGE_RESULT');
      });
    }
    case 'raw-delete-next': {
      const bodies = rawBodies(16);
      let current = plan(context, 'raw-delete', 17);
      current = stage(context, current, bodies.map((body, index) => row(index + 1, body)));
      current = buildAll(context, current);
      current = stage(context, current, [row(17, '_')]);
      current = buildAll(context, current);
      const indexed = state(activateChat(context.db, { expectedState: current }).state);
      const removal = state(startRemoval(context.db, indexed.chatId).state);
      return measureMutation(context, () => {
        const result = cleanupStep(context.db, { expectedState: removal });
        invariant(result.disposition === 'cleanup-progress'
          && result.deletedRows === 16
          && result.deletedTerms === 0
          && result.state.activeChunkId !== null, 'SEARCH_PROOF_RAW_DELETE_RESULT');
      });
    }
    case 'activation': {
      let current = plan(context, 'activation', 16);
      current = stage(context, current, Array.from({ length: 16 }, (_, index) => row(index + 1, '_')));
      current = buildAll(context, current);
      return measureMutation(context, () => {
        const result = activateChat(context.db, { expectedState: current });
        invariant(result.disposition === 'indexed'
          && result.state.status === 'indexed', 'SEARCH_PROOF_ACTIVATION_RESULT');
      });
    }
    case 'indexed-to-pending': {
      const indexed = indexRows(context, 'pending', [row(1, '_')]);
      return measureMutation(context, () => {
        const result = planAppend(context.db, {
          chatId: indexed.chatId,
          transcriptViewId: indexed.transcriptViewId,
          expectedAfterOrdinal: 1,
          targetThrough: 2,
        });
        invariant(result.disposition === 'build'
          && result.state.phase === 'append-build', 'SEARCH_PROOF_PENDING_RESULT');
      });
    }
    case 'prune-16': {
      for (let index = 0; index < 16; index += 1) indexRows(context, `prune-${index}`, [row(1, '_')]);
      return measureMutation(context, () => {
        const result = markPrunedChats(context.db, { allowedChatIds: [], afterChatId: 'y' });
        invariant(result.disposition === 'prune-progress'
          && result.cleanups.length === 16
          && !result.done, 'SEARCH_PROOF_PRUNE_RESULT');
      });
    }
    case 'frontier': {
      const current = plan(context, 'frontier', 100);
      return measureMutation(context, () => {
        const result = advanceFrontier(context.db, { expectedState: current, throughOrdinal: 100 });
        invariant(result.disposition === 'frontier-progress'
          && result.state.processedThrough === 100, 'SEARCH_PROOF_FRONTIER_RESULT');
      });
    }
    case 'failure': {
      const current = plan(context, 'failure', 1);
      return measureMutation(context, () => {
        const result = markChatFailed(context.db, {
          expectedState: current,
          errorCode: 'SEARCH_TOKENIZER_INVALID',
        });
        invariant(result.disposition === 'failure-recorded'
          && result.applied, 'SEARCH_PROOF_FAILURE_RESULT');
      });
    }
    case 'replacement-checkpoint': {
      const indexed = indexRows(context, 'checkpoint-old', [row(1, '_')]);
      let current = planReplacement(context.db, {
        chatId: indexed.chatId,
        transcriptViewId: proofIdentifier('v-checkpoint-new', 'w'),
        targetThrough: 1,
      }).state;
      const first = cleanupStep(context.db, { expectedState: current });
      invariant(first.disposition === 'cleanup-progress', 'SEARCH_PROOF_RAW_CLEANUP');
      current = first.state;
      return measureMutation(context, () => {
        const result = cleanupStep(context.db, { expectedState: current });
        invariant(result.disposition === 'replacement-checkpoint',
          'SEARCH_PROOF_REPLACEMENT_CHECKPOINT_RESULT');
      });
    }
    case 'state-removal': {
      const current = plan(context, 'state-remove', 0);
      const removal = state(startRemoval(context.db, current.chatId).state);
      return measureMutation(context, () => {
        const result = cleanupStep(context.db, { expectedState: removal });
        invariant(result.disposition === 'chat-deleted', 'SEARCH_PROOF_STATE_REMOVAL_RESULT');
      });
    }
    case 'current': {
      const indexed = indexRows(context, 'current', []);
      return measureMutation(context, () => {
        const result = planReplacement(context.db, {
          chatId: indexed.chatId,
          transcriptViewId: indexed.transcriptViewId,
          targetThrough: 0,
        });
        invariant(result.disposition === 'current', 'SEARCH_PROOF_CURRENT_RESULT');
      });
    }
    case 'superseded': {
      const current = plan(context, 'superseded', 1);
      const stale = { ...current, updatedAt: '2026-08-19T23:59:59.999Z' };
      const rows = [row(1, '_')];
      const documents = context.tokenizer.tokenizeDocuments(rows.map((entry) => entry.body)).documents;
      return measureMutation(context, () => {
        const result = stageRawChunks(context.db, { expectedState: stale, rows, documents });
        invariant(result.disposition === 'superseded', 'SEARCH_PROOF_SUPERSEDED_RESULT');
      });
    }
  }
}

async function runScenario(shape: ProofShape, operation: ProofOperation): Promise<MutationMeasurement> {
  const root = mkdtempSync(path.join('/var/tmp', 'transcript-search-v8-proof-'));
  const dbPath = path.join(root, 'index.sqlite');
  const tokenizer = SearchTokenizer.create();
  let db: Database | null = null;
  try {
    const opened = await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint });
    db = opened.db;
    verifyRuntimeIdentity(db, tokenizer);
    seedShape(db, shape);
    const measurement = executeScenario({ db, dbPath, tokenizer, shape, operation });
    const integrity = String(Object.values(db.query('PRAGMA integrity_check').get() ?? {})[0]);
    invariant(integrity === 'ok', 'SEARCH_PROOF_INTEGRITY');
    invariant(db.query('PRAGMA foreign_key_check').all().length === 0, 'SEARCH_PROOF_FOREIGN_KEYS');
    return measurement;
  } finally {
    if (db) closeSearchDatabase(db);
    tokenizer.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function explainOpcodes(db: Database, sql: string, bindings: readonly unknown[]): string[] {
  return db.query<{ opcode: string }, unknown[]>(`EXPLAIN ${sql}`).all(...bindings)
    .map((row) => row.opcode);
}

async function runExplainProof(): Promise<Record<string, readonly string[]>> {
  const root = mkdtempSync(path.join('/var/tmp', 'transcript-search-v8-explain-'));
  const dbPath = path.join(root, 'index.sqlite');
  const tokenizer = SearchTokenizer.create();
  let db: Database | null = null;
  try {
    db = (await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint })).db;
    const statements = {
      greatest: [SEARCH_GREATEST_PERSISTED_POSTING_SQL, [1]],
      successor: [SEARCH_PERSISTED_SUCCESSOR_SQL, [1, Buffer.from('term')]],
      firstSlot: [SEARCH_FIRST_SLOT_CHUNK_SQL, ['chat']],
      nextView: [SEARCH_NEXT_VIEW_CHUNK_SQL, ['chat', 'view', 0]],
      rawDelete: [SEARCH_RAW_DELETE_CANDIDATES_SQL, ['chat', 'view', 1]],
      hasTerms: [SEARCH_CHUNK_HAS_TERMS_SQL, [1]],
      pruneCorpus: [SEARCH_PRUNE_CORPUS_SUBTRACT_SQL, [0, 0, 0, 0]],
    } as const;
    const output: Record<string, readonly string[]> = {};
    for (const [name, [sql, bindings]] of Object.entries(statements)) {
      output[name] = explainOpcodes(db, sql, bindings);
    }
    invariant(output.greatest.includes('SeekLE'), 'SEARCH_PROOF_EXPLAIN_GREATEST');
    invariant(output.successor.includes('SeekGT'), 'SEARCH_PROOF_EXPLAIN_SUCCESSOR');
    for (const name of ['greatest', 'successor', 'firstSlot', 'nextView', 'rawDelete', 'hasTerms']) {
      const opcodes = output[name]!;
      invariant(!opcodes.includes('SorterOpen') && !opcodes.includes('OpenEphemeral'),
        `SEARCH_PROOF_EXPLAIN_SORT:${name}`);
      invariant(!opcodes.includes('Rewind'), `SEARCH_PROOF_EXPLAIN_REWIND:${name}`);
    }
    return output;
  } finally {
    if (db) closeSearchDatabase(db);
    tokenizer.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function runMatrix(): Promise<void> {
  const results: MutationMeasurement[] = [];
  for (const shape of TRANSCRIPT_SEARCH_V8_PROOF_SHAPES) {
    for (const operation of TRANSCRIPT_SEARCH_V8_PROOF_OPERATIONS) {
      const result = await runScenario(shape, operation);
      results.push(result);
      console.error(`PASS ${shape} ${operation} frames=${result.frames}`);
    }
  }
  const explain = await runExplainProof();
  console.log(JSON.stringify({
    runtime: {
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      sqliteVersion: TRANSCRIPT_SEARCH_V8_PROOF_SQLITE_VERSION,
      fts5SourceId: SEARCH_APPROVED_FTS5_SOURCE_ID,
    },
    constants: {
      K: SEARCH_TERM_STEP_MAX_ROWS,
      F: SEARCH_MAX_DIRTY_FRAMES,
      H: SEARCH_WAL_HIGH_WATER_FRAMES,
      cacheSize: SEARCH_INDEXER_CACHE_SIZE_PAGES,
      maximumWalBytes: SEARCH_MAX_WAL_BYTES,
      schemaSqlSha256: SEARCH_SCHEMA_SQL_SHA256,
    },
    results,
    explain,
  }));
}

async function runFullHighWater(): Promise<void> {
  const root = mkdtempSync(path.join('/var/tmp', 'transcript-search-v8-full-h-'));
  const dbPath = path.join(root, 'index.sqlite');
  const tokenizer = SearchTokenizer.create();
  let db: Database | null = null;
  try {
    db = (await openSearchDatabase(dbPath, { tokenizerFingerprint: tokenizer.fingerprint })).db;
    const identity = verifyRuntimeIdentity(db, tokenizer);
    const chatId = 'full-h-chat';
    const viewId = 'full-h-view';
    planReplacement(db, { chatId, transcriptViewId: viewId, targetThrough: SEARCH_WAL_HIGH_WATER_FRAMES + 1_000 });
    const body = '_'.repeat(3_500);
    const rows = SEARCH_WAL_HIGH_WATER_FRAMES + 1_000;
    const insert = db.query(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
        token_count, term_count, term_bytes, position_bytes
      ) VALUES (?, ?, ?, 0, NULL, ?, 3500, 1, 0, 0, 0)
    `);
    for (let start = 1; start <= rows; start += 5_000) {
      const end = Math.min(rows, start + 4_999);
      transaction(db, () => {
        for (let ordinal = start; ordinal <= end; ordinal += 1) {
          insert.run(chatId, viewId, ordinal, body);
        }
      });
      const checkpoint = truncateWal(db);
      invariant(checkpoint.busy === 0 && checkpoint.logFrames === 0, 'SEARCH_PROOF_BUILD_TRUNCATE');
    }
    const initial = truncateWal(db);
    invariant(initial.busy === 0 && initial.logFrames === 0, 'SEARCH_PROOF_FULL_H_INITIAL');
    const update = db.query('UPDATE search_chunks SET role = 1 - role WHERE id BETWEEN ? AND ?');
    let cursor = 0;
    let observation = observeWal(db);
    while (observation.logFrames < SEARCH_WAL_HIGH_WATER_FRAMES) {
      const requested = Math.min(5_000, SEARCH_WAL_HIGH_WATER_FRAMES - observation.logFrames);
      transaction(db, () => { update.run(cursor + 1, cursor + requested); });
      const next = observeWal(db);
      invariant(next.logFrames - observation.logFrames === requested,
        `SEARCH_PROOF_FULL_H_DELTA:${requested}:${next.logFrames - observation.logFrames}`);
      cursor += requested;
      observation = next;
    }
    invariant(cursor === SEARCH_WAL_HIGH_WATER_FRAMES, 'SEARCH_PROOF_FULL_H_CURSOR');
    invariant(observation.logFrames === SEARCH_WAL_HIGH_WATER_FRAMES
      && observation.checkpointedFrames === 0, 'SEARCH_PROOF_FULL_H_OBSERVATION');
    const walPath = `${dbPath}-wal`;
    const walBytesBefore = statSync(walPath).size;
    invariant(walBytesBefore === SEARCH_MAX_WAL_BYTES, 'SEARCH_PROOF_FULL_H_WAL_BYTES');
    const started = performance.now();
    const truncated = truncateWal(db);
    const durationMs = performance.now() - started;
    const after = observeWal(db);
    const walBytesAfter = statSync(walPath).size;
    invariant(truncated.busy === 0 && truncated.logFrames === 0 && truncated.checkpointedFrames === 0,
      'SEARCH_PROOF_FULL_H_TRUNCATE');
    invariant(after.logFrames === 0 && after.checkpointedFrames === 0,
      'SEARCH_PROOF_FULL_H_AFTER');
    invariant(walBytesAfter === 0, 'SEARCH_PROOF_FULL_H_ZERO_WAL');
    invariant(durationMs < 30_000, 'SEARCH_PROOF_FULL_H_TIMEOUT');
    invariant(String(Object.values(db.query('PRAGMA integrity_check').get() ?? {})[0]) === 'ok',
      'SEARCH_PROOF_FULL_H_INTEGRITY');
    invariant(db.query('PRAGMA foreign_key_check').all().length === 0,
      'SEARCH_PROOF_FULL_H_FOREIGN_KEYS');
    console.log(JSON.stringify({
      runtime: identity,
      H: SEARCH_WAL_HIGH_WATER_FRAMES,
      cacheSize: SEARCH_INDEXER_CACHE_SIZE_PAGES,
      pageCount: pragmaNumber(db, 'PRAGMA page_count'),
      uniqueUpdatedRows: cursor,
      walBytesBefore,
      walBytesAfter,
      durationMs,
      truncated,
      after,
    }));
  } finally {
    if (db) closeSearchDatabase(db);
    tokenizer.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runTranscriptSearchV8Proof(args: readonly string[]): Promise<void> {
  const mode = args[0] ?? '--matrix';
  if (mode === '--matrix') return runMatrix();
  if (mode === '--rss') {
    const result = runTranscriptSearchV8RssProof({
      proofPath: import.meta.path,
      operations: TRANSCRIPT_SEARCH_V8_RSS_OPERATIONS,
      shapes: TRANSCRIPT_SEARCH_V8_RSS_SHAPES,
      ceilingBytes: SEARCH_INDEXER_MAX_STEP_RSS_DELTA_BYTES,
    });
    console.log(JSON.stringify(result));
    return;
  }
  if (mode === '--full-h') return runFullHighWater();
  if (mode === '--rss-case') {
    const operation = args[1] as ProofOperation;
    const shape = args[2] as ProofShape;
    invariant(TRANSCRIPT_SEARCH_V8_RSS_OPERATIONS.includes(operation as never),
      'SEARCH_PROOF_RSS_OPERATION');
    invariant(TRANSCRIPT_SEARCH_V8_RSS_SHAPES.includes(shape as never), 'SEARCH_PROOF_RSS_SHAPE');
    console.log(JSON.stringify(await runScenario(shape, operation)));
    return;
  }
  throw new Error(`Unknown transcript search v8 proof mode: ${mode}`);
}

if (import.meta.main) await runTranscriptSearchV8Proof(process.argv.slice(2));
