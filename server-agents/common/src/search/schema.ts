import { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoricalSearchMessageRow } from './rows.js';
import {
  compareSearchTerms,
  decodeCanonicalPositions,
  type TokenizedDocument,
} from './tokenizer.js';

export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 8;
export const SEARCH_INDEX_PAGE_SIZE = 4_096;
export const SEARCH_TERM_STEP_MAX_ROWS = 32;
export const SEARCH_TERM_STEP_MAX_BYTES = 512 * 1_024;
export const SEARCH_RAW_STAGE_MAX_ROWS = 16;
export const SEARCH_RAW_STAGE_MAX_BYTES = 1_048_576;
export const SEARCH_PRUNE_MAX_STATES = 16;
export const SEARCH_MAX_DIRTY_FRAMES = 49_829;
export const SEARCH_WAL_HIGH_WATER_FRAMES = 199_316;
export const SEARCH_INDEXER_CACHE_HEADROOM_PAGES = 64;
export const SEARCH_INDEXER_CACHE_SIZE_PAGES = 49_893;
export const SEARCH_MAX_WAL_BYTES = 821_181_952;
export const SEARCH_INDEXER_MAX_STEP_RSS_DELTA_BYTES = 256 * 1_024 * 1_024;

export const SEARCH_ACTIVE_COMPLETE_PREDICATE = `
  progress.complete = 1
  AND state.status = 'indexed'
  AND state.phase = 'idle'
  AND state.transcript_view_id = chunks.transcript_view_id
  AND chunks.ordinal <= state.processed_through
  AND state.processed_through = state.target_through
`;
export const SEARCH_PRUNE_CORPUS_SUBTRACT_SQL = `
  UPDATE search_corpus_stats
  SET document_count = document_count - ?, total_token_count = total_token_count - ?
  WHERE singleton = 1 AND document_count >= ? AND total_token_count >= ?
`;
export const SEARCH_GREATEST_PERSISTED_POSTING_SQL = `
  SELECT term, frequency, positions FROM search_chunk_terms
  WHERE chunk_id = ? ORDER BY term DESC LIMIT 1
`;
export const SEARCH_PERSISTED_SUCCESSOR_SQL = `
  SELECT term FROM search_chunk_terms
  WHERE chunk_id = ? AND term > ? ORDER BY term LIMIT 1
`;
export const SEARCH_FIRST_SLOT_CHUNK_SQL = `
  SELECT id, transcript_view_id AS transcriptViewId, ordinal
  FROM search_chunks
  WHERE chat_id = ?
  ORDER BY transcript_view_id, ordinal
  LIMIT 1
`;
export const SEARCH_NEXT_VIEW_CHUNK_SQL = `
  SELECT chunks.id, chunks.ordinal, progress.complete
  FROM search_chunks AS chunks
  JOIN search_chunk_progress AS progress ON progress.chunk_id = chunks.id
  WHERE chunks.chat_id = ? AND chunks.transcript_view_id = ? AND chunks.ordinal > ?
  ORDER BY chunks.ordinal
  LIMIT 1
`;
export const SEARCH_RAW_DELETE_CANDIDATES_SQL = `
  SELECT chunks.id, chunks.chat_id AS chatId,
    chunks.transcript_view_id AS transcriptViewId, chunks.ordinal,
    chunks.role, chunks.timestamp, chunks.body, chunks.body_bytes AS bodyBytes,
    chunks.token_count AS tokenCount, chunks.term_count AS termCount,
    chunks.term_bytes AS termBytes, chunks.position_bytes AS positionBytes,
    progress.chunk_id AS chunkId, progress.complete,
    progress.persisted_term_count AS persistedTermCount,
    progress.persisted_occurrence_count AS persistedOccurrenceCount,
    progress.persisted_term_bytes AS persistedTermBytes,
    progress.persisted_position_bytes AS persistedPositionBytes,
    progress.term_cursor AS termCursor
  FROM search_chunks AS chunks
  JOIN search_chunk_progress AS progress ON progress.chunk_id = chunks.id
  WHERE chunks.chat_id = ? AND chunks.transcript_view_id = ? AND chunks.ordinal >= ?
  ORDER BY chunks.ordinal
  LIMIT ${SEARCH_RAW_STAGE_MAX_ROWS}
`;
export const SEARCH_CHUNK_HAS_TERMS_SQL = `
  SELECT EXISTS(
    SELECT 1 FROM search_chunk_terms WHERE chunk_id = ? LIMIT 1
  ) AS present
`;

export type SearchChatStatus = 'pending' | 'indexed' | 'failed';
export type SearchMutationPhase =
  | 'idle'
  | 'append-build'
  | 'replacement-cleanup'
  | 'replacement-checkpoint'
  | 'replacement-build'
  | 'removal-cleanup';

export interface SearchChatState {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly status: SearchChatStatus;
  readonly phase: SearchMutationPhase;
  readonly targetThrough: number;
  readonly processedThrough: number;
  readonly activeChunkId: number | null;
  readonly slotDocumentCount: number;
  readonly slotTokenCount: number;
  readonly lastErrorCode: string | null;
  readonly updatedAt: string;
}

export interface SearchDatabase {
  readonly db: Database;
  readonly dbPath: string;
  readonly recreated: boolean;
}

export interface SearchDatabaseOpenOptions {
  readonly tokenizerFingerprint: Uint8Array;
}

export interface WalCheckpointStatus {
  readonly busy: number;
  readonly logFrames: number;
  readonly checkpointedFrames: number;
}

export interface PrunedChatCleanup {
  readonly expectedState: SearchChatState;
}

export type SyncPlanDisposition = 'current' | 'build' | 'cleanup' | 'checkpoint';

export interface SyncPlanResult {
  readonly disposition: SyncPlanDisposition;
  readonly state: SearchChatState;
}

export interface RawStageResult {
  readonly disposition: 'raw-staged' | 'superseded';
  readonly state?: SearchChatState;
  readonly acceptedRows?: number;
}

export interface TermBuildResult {
  readonly disposition: 'term-progress' | 'superseded';
  readonly state?: SearchChatState;
  readonly insertedTerms?: number;
  readonly insertedOccurrences?: number;
  readonly completedChunk?: boolean;
}

export interface FrontierResult {
  readonly disposition: 'frontier-progress' | 'superseded';
  readonly state?: SearchChatState;
}

export interface ActivationResult {
  readonly disposition: 'indexed' | 'superseded';
  readonly state?: SearchChatState;
}

export type CleanupResult =
  | {
      readonly disposition: 'cleanup-progress';
      readonly state: SearchChatState;
      readonly deletedTerms: number;
      readonly deletedRows: number;
      readonly deletedBodyBytes: number;
    }
  | { readonly disposition: 'replacement-checkpoint'; readonly state: SearchChatState }
  | { readonly disposition: 'chat-deleted'; readonly chatId: string }
  | { readonly disposition: 'superseded'; readonly chatId: string };

export interface FailureRecordResult {
  readonly disposition: 'failure-recorded';
  readonly applied: boolean;
}

export interface PruneMarkResult {
  readonly disposition: 'prune-progress';
  readonly cleanups: readonly PrunedChatCleanup[];
  readonly nextAfterChatId: string | null;
  readonly done: boolean;
}

interface SearchChunkRow {
  readonly id: number;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal: number;
  readonly role: number;
  readonly timestamp: string | null;
  readonly body: string;
  readonly bodyBytes: number;
  readonly tokenCount: number;
  readonly termCount: number;
  readonly termBytes: number;
  readonly positionBytes: number;
}

interface SearchChunkProgress {
  readonly chunkId: number;
  readonly complete: number;
  readonly persistedTermCount: number;
  readonly persistedOccurrenceCount: number;
  readonly persistedTermBytes: number;
  readonly persistedPositionBytes: number;
  readonly termCursor: Uint8Array | null;
}

interface ChunkWithProgress extends SearchChunkRow, SearchChunkProgress {}

type SearchSqlBinding = string | number | null | Uint8Array;

const ROLE_CODES = { user: 0, assistant: 1, tool: 2, system: 3 } as const;
const STATE_MATCH_SQL = `
  chat_id = ? AND transcript_view_id = ? AND status = ? AND phase = ?
  AND target_through = ? AND processed_through = ? AND active_chunk_id IS ?
  AND slot_document_count = ? AND slot_token_count = ? AND last_error_code IS ?
  AND updated_at = ?
`;
const PROGRESS_MATCH_SQL = `
  chunk_id = ? AND complete = ? AND persisted_term_count = ?
  AND persisted_occurrence_count = ? AND persisted_term_bytes = ?
  AND persisted_position_bytes = ? AND term_cursor IS ?
`;

function searchError(code: string): Error {
  return new Error(code);
}

function isSafeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validBoundedText(value: string, maximumBytes: number, allowEmpty = false): boolean {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && hasWellFormedUtf16(value)
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

function requireIdentifier(value: string): void {
  if (!validBoundedText(value, 256)) throw searchError('SEARCH_IDENTIFIER_INVALID');
}

function requireFingerprint(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw searchError('SEARCH_TOKENIZER_FINGERPRINT_INVALID');
  }
}

function stateArguments(state: SearchChatState): readonly SearchSqlBinding[] {
  return [
    state.chatId,
    state.transcriptViewId,
    state.status,
    state.phase,
    state.targetThrough,
    state.processedThrough,
    state.activeChunkId,
    state.slotDocumentCount,
    state.slotTokenCount,
    state.lastErrorCode,
    state.updatedAt,
  ];
}

function progressArguments(progress: SearchChunkProgress): readonly SearchSqlBinding[] {
  return [
    progress.chunkId,
    progress.complete,
    progress.persistedTermCount,
    progress.persistedOccurrenceCount,
    progress.persistedTermBytes,
    progress.persistedPositionBytes,
    progress.termCursor,
  ];
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return compareSearchTerms(left, right) === 0;
}

function sameState(
  left: SearchChatState | null,
  right: SearchChatState,
): left is SearchChatState {
  return left !== null
    && left.chatId === right.chatId
    && left.transcriptViewId === right.transcriptViewId
    && left.status === right.status
    && left.phase === right.phase
    && left.targetThrough === right.targetThrough
    && left.processedThrough === right.processedThrough
    && left.activeChunkId === right.activeChunkId
    && left.slotDocumentCount === right.slotDocumentCount
    && left.slotTokenCount === right.slotTokenCount
    && left.lastErrorCode === right.lastErrorCode
    && left.updatedAt === right.updatedAt;
}

function sameProgress(left: SearchChunkProgress, right: SearchChunkProgress): boolean {
  return left.chunkId === right.chunkId
    && left.complete === right.complete
    && left.persistedTermCount === right.persistedTermCount
    && left.persistedOccurrenceCount === right.persistedOccurrenceCount
    && left.persistedTermBytes === right.persistedTermBytes
    && left.persistedPositionBytes === right.persistedPositionBytes
    && sameBytes(left.termCursor, right.termCursor);
}

function nextTimestamp(previous?: string): string {
  const now = Date.now();
  const prior = previous === undefined ? Number.NaN : Date.parse(previous);
  return new Date(Number.isFinite(prior) && prior >= now ? prior + 1 : now).toISOString();
}

function runTransaction<T>(db: Database, work: () => T): T {
  requireWalCapacity(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function requireOneChange(result: { readonly changes: number }): void {
  if (Number(result.changes) !== 1) throw searchError('SEARCH_STATE_INVARIANT');
}

function pragmaNumber(db: Database, sql: string, key: string): number {
  const row = db.query<Record<string, number>, []>(sql).get();
  return Number(row?.[key]);
}

function pragmaString(db: Database, sql: string, key: string): string {
  const row = db.query<Record<string, string>, []>(sql).get();
  return String(row?.[key] ?? '');
}

function validatePageLayout(db: Database): void {
  if (pragmaNumber(db, 'PRAGMA page_size', 'page_size') !== SEARCH_INDEX_PAGE_SIZE
      || pragmaNumber(db, 'PRAGMA auto_vacuum', 'auto_vacuum') !== 0) {
    throw searchError('SEARCH_SCHEMA_LAYOUT_INVALID');
  }
}

function configureWriteConnection(db: Database): void {
  const journalMode = pragmaString(db, 'PRAGMA journal_mode = WAL', 'journal_mode').toLowerCase();
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA wal_autocheckpoint = 0');
  db.exec('PRAGMA cache_spill = OFF');
  db.exec(`PRAGMA cache_size = ${SEARCH_INDEXER_CACHE_SIZE_PAGES}`);
  db.exec('PRAGMA busy_timeout = 5000');
  if (journalMode !== 'wal'
      || pragmaNumber(db, 'PRAGMA synchronous', 'synchronous') !== 1
      || pragmaNumber(db, 'PRAGMA foreign_keys', 'foreign_keys') !== 1
      || pragmaNumber(db, 'PRAGMA secure_delete', 'secure_delete') !== 1
      || pragmaNumber(db, 'PRAGMA wal_autocheckpoint', 'wal_autocheckpoint') !== 0
      || pragmaNumber(db, 'PRAGMA cache_spill', 'cache_spill') !== 0
      || pragmaNumber(db, 'PRAGMA cache_size', 'cache_size') !== SEARCH_INDEXER_CACHE_SIZE_PAGES) {
    throw searchError('SEARCH_DATABASE_CONFIGURATION');
  }
}

function configureReadConnection(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 2000');
  db.exec('PRAGMA temp_store = MEMORY');
  if (pragmaNumber(db, 'PRAGMA foreign_keys', 'foreign_keys') !== 1
      || pragmaNumber(db, 'PRAGMA temp_store', 'temp_store') !== 2) {
    throw searchError('SEARCH_DATABASE_CONFIGURATION');
  }
}

function createSchema(db: Database, tokenizerFingerprint: Uint8Array): void {
  runTransaction(db, () => {
    db.exec(`
      CREATE TABLE search_chat_state (
        chat_id              TEXT PRIMARY KEY
                             CHECK(length(CAST(chat_id AS BLOB)) BETWEEN 1 AND 256),
        transcript_view_id   TEXT NOT NULL
                             CHECK(length(CAST(transcript_view_id AS BLOB)) BETWEEN 1 AND 256),
        status               TEXT NOT NULL
                             CHECK(status IN ('pending', 'indexed', 'failed')),
        phase                TEXT NOT NULL CHECK(phase IN (
                               'idle',
                               'append-build',
                               'replacement-cleanup',
                               'replacement-checkpoint',
                               'replacement-build',
                               'removal-cleanup'
                             )),
        target_through       INTEGER NOT NULL CHECK(target_through >= 0),
        processed_through    INTEGER NOT NULL
                             CHECK(processed_through BETWEEN 0 AND target_through),
        active_chunk_id      INTEGER CHECK(active_chunk_id IS NULL OR active_chunk_id > 0),
        slot_document_count  INTEGER NOT NULL CHECK(slot_document_count >= 0),
        slot_token_count     INTEGER NOT NULL
                             CHECK(slot_token_count >= slot_document_count),
        last_error_code      TEXT CHECK(
                               last_error_code IS NULL OR
                               length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND 64
                             ),
        updated_at           TEXT NOT NULL
                             CHECK(length(CAST(updated_at AS BLOB)) BETWEEN 1 AND 64),
        CHECK (
          (status = 'indexed' AND phase = 'idle'
            AND processed_through = target_through
            AND active_chunk_id IS NULL AND last_error_code IS NULL)
          OR
          (status = 'pending' AND phase <> 'idle' AND last_error_code IS NULL)
          OR
          (status = 'failed'
            AND phase IN ('append-build', 'replacement-build')
            AND last_error_code IS NOT NULL)
        ),
        CHECK (
          phase <> 'replacement-checkpoint' OR
          (active_chunk_id IS NULL AND slot_document_count = 0 AND slot_token_count = 0)
        )
      ) WITHOUT ROWID, STRICT;

      CREATE TABLE search_chunks (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id             TEXT NOT NULL
                            REFERENCES search_chat_state(chat_id) ON DELETE RESTRICT,
        transcript_view_id  TEXT NOT NULL
                            CHECK(length(CAST(transcript_view_id AS BLOB)) BETWEEN 1 AND 256),
        ordinal             INTEGER NOT NULL CHECK(ordinal > 0),
        role                INTEGER NOT NULL CHECK(role IN (0, 1, 2, 3)),
        timestamp           TEXT CHECK(
                              timestamp IS NULL OR
                              length(CAST(timestamp AS BLOB)) <= 256
                            ),
        body                TEXT NOT NULL,
        body_bytes          INTEGER NOT NULL
                            CHECK(body_bytes > 0
                              AND body_bytes = length(CAST(body AS BLOB))
                              AND body_bytes <= 1048576),
        token_count         INTEGER NOT NULL CHECK(token_count >= 1),
        term_count          INTEGER NOT NULL
                            CHECK(term_count BETWEEN 0 AND token_count - 1),
        term_bytes          INTEGER NOT NULL CHECK(term_bytes >= term_count),
        position_bytes      INTEGER NOT NULL CHECK(position_bytes >= token_count - 1),
        UNIQUE(chat_id, transcript_view_id, ordinal)
      ) STRICT;

      CREATE TABLE search_chunk_progress (
        chunk_id                   INTEGER PRIMARY KEY
                                   REFERENCES search_chunks(id) ON DELETE RESTRICT,
        complete                   INTEGER NOT NULL CHECK(complete IN (0, 1)),
        persisted_term_count       INTEGER NOT NULL CHECK(persisted_term_count >= 0),
        persisted_occurrence_count INTEGER NOT NULL CHECK(persisted_occurrence_count >= 0),
        persisted_term_bytes       INTEGER NOT NULL CHECK(persisted_term_bytes >= 0),
        persisted_position_bytes   INTEGER NOT NULL CHECK(persisted_position_bytes >= 0),
        term_cursor                BLOB CHECK(
                                     term_cursor IS NULL OR
                                     length(term_cursor) BETWEEN 1 AND 32768
                                   ),
        CHECK (
          (persisted_term_count = 0
            AND persisted_occurrence_count = 0
            AND persisted_term_bytes = 0
            AND persisted_position_bytes = 0
            AND term_cursor IS NULL)
          OR
          (persisted_term_count > 0
            AND persisted_occurrence_count > 0
            AND persisted_term_bytes > 0
            AND persisted_position_bytes > 0
            AND term_cursor IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX search_chunk_progress_complete
        ON search_chunk_progress(chunk_id) WHERE complete = 1;

      CREATE TABLE search_chunk_terms (
        chunk_id    INTEGER NOT NULL
                    REFERENCES search_chunks(id) ON DELETE RESTRICT,
        chat_id     TEXT NOT NULL
                    CHECK(length(CAST(chat_id AS BLOB)) BETWEEN 1 AND 256),
        term        BLOB NOT NULL CHECK(length(term) BETWEEN 1 AND 32768),
        frequency   INTEGER NOT NULL CHECK(frequency > 0),
        positions   BLOB NOT NULL CHECK(length(positions) > 0),
        PRIMARY KEY(chunk_id, term)
      ) WITHOUT ROWID, STRICT;

      CREATE INDEX search_chunk_terms_by_term
        ON search_chunk_terms(term, chat_id, chunk_id);

      CREATE TABLE search_corpus_stats (
        singleton          INTEGER PRIMARY KEY CHECK(singleton = 1),
        document_count     INTEGER NOT NULL CHECK(document_count >= 0),
        total_token_count  INTEGER NOT NULL CHECK(total_token_count >= document_count)
      ) WITHOUT ROWID, STRICT;

      INSERT INTO search_corpus_stats VALUES (1, 0, 0);

      CREATE TABLE search_index_metadata (
        singleton               INTEGER PRIMARY KEY CHECK(singleton = 1),
        tokenizer_fingerprint   BLOB NOT NULL CHECK(length(tokenizer_fingerprint) = 32)
      ) WITHOUT ROWID, STRICT;
    `);
    db.query('INSERT INTO search_index_metadata VALUES (1, ?)').run(tokenizerFingerprint);
    db.exec(`PRAGMA user_version = ${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`);
  });
}

function validateExistingSchema(db: Database, tokenizerFingerprint: Uint8Array): void {
  validatePageLayout(db);
  const version = pragmaNumber(db, 'PRAGMA user_version', 'user_version');
  if (version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION) {
    throw searchError('SEARCH_SCHEMA_VERSION_INVALID');
  }
  const stored = db.query<{ fingerprint: Uint8Array }, []>(`
    SELECT tokenizer_fingerprint AS fingerprint
    FROM search_index_metadata WHERE singleton = 1
  `).get()?.fingerprint;
  if (!(stored instanceof Uint8Array)
      || stored.byteLength !== 32
      || !Buffer.from(stored).equals(Buffer.from(tokenizerFingerprint))) {
    throw searchError('SEARCH_TOKENIZER_FINGERPRINT_MISMATCH');
  }
}

async function unlinkDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .map((file) => fs.rm(file, { force: true })),
  );
}

async function protectDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(async (file) => {
    try {
      await fs.chmod(file, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
}

async function createFreshDatabase(
  dbPath: string,
  tokenizerFingerprint: Uint8Array,
): Promise<SearchDatabase> {
  await unlinkDatabaseFiles(dbPath);
  const db = new Database(dbPath);
  try {
    db.exec(`PRAGMA page_size = ${SEARCH_INDEX_PAGE_SIZE}`);
    db.exec('PRAGMA auto_vacuum = NONE');
    validatePageLayout(db);
    configureWriteConnection(db);
    createSchema(db, tokenizerFingerprint);
    validateExistingSchema(db, tokenizerFingerprint);
    await protectDatabaseFiles(dbPath);
    return { db, dbPath, recreated: true };
  } catch (error) {
    db.close(false);
    await unlinkDatabaseFiles(dbPath);
    throw error;
  }
}

export async function openSearchDatabase(
  dbPath: string,
  options: SearchDatabaseOpenOptions,
): Promise<SearchDatabase> {
  requireFingerprint(options.tokenizerFingerprint);
  await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const exists = await fs.stat(dbPath)
    .then((entry) => entry.isFile() && entry.size > 0)
    .catch(() => false);
  if (!exists) return createFreshDatabase(dbPath, options.tokenizerFingerprint);
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    validateExistingSchema(db, options.tokenizerFingerprint);
    configureWriteConnection(db);
    validateExistingSchema(db, options.tokenizerFingerprint);
    await protectDatabaseFiles(dbPath);
    return { db, dbPath, recreated: false };
  } catch {
    db?.close(false);
    await unlinkDatabaseFiles(dbPath);
    return createFreshDatabase(dbPath, options.tokenizerFingerprint);
  }
}

export function openSearchReadDatabase(
  dbPath: string,
  options: SearchDatabaseOpenOptions,
): Database {
  requireFingerprint(options.tokenizerFingerprint);
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    validateExistingSchema(db, options.tokenizerFingerprint);
    configureReadConnection(db);
    return db;
  } catch (error) {
    db.close(false);
    throw error;
  }
}

export function closeSearchDatabase(db: Database): void {
  db.close();
}

export function observeWal(db: Database): WalCheckpointStatus {
  const row = db.query<{ busy: number; log: number; checkpointed: number }, []>(
    'PRAGMA wal_checkpoint(NOOP)',
  ).get();
  const result = {
    busy: Number(row?.busy),
    logFrames: Number(row?.log),
    checkpointedFrames: Number(row?.checkpointed),
  };
  if (![result.busy, result.logFrames, result.checkpointedFrames]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
      || result.checkpointedFrames > result.logFrames) {
    throw searchError('SEARCH_WAL_OBSERVATION_INVALID');
  }
  return result;
}

export function requireWalCapacity(db: Database): WalCheckpointStatus {
  const status = observeWal(db);
  if (status.logFrames + SEARCH_MAX_DIRTY_FRAMES > SEARCH_WAL_HIGH_WATER_FRAMES
      || status.logFrames - status.checkpointedFrames + SEARCH_MAX_DIRTY_FRAMES
        > SEARCH_WAL_HIGH_WATER_FRAMES) {
    throw searchError('SEARCH_WAL_MAINTENANCE_REQUIRED');
  }
  return status;
}

export function truncateWal(db: Database): WalCheckpointStatus {
  const row = db.query<{ busy: number; log: number; checkpointed: number }, []>(
    'PRAGMA wal_checkpoint(TRUNCATE)',
  ).get();
  const result = {
    busy: Number(row?.busy),
    logFrames: Number(row?.log),
    checkpointedFrames: Number(row?.checkpointed),
  };
  if (![result.busy, result.logFrames, result.checkpointedFrames]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
      || result.checkpointedFrames > result.logFrames) {
    throw searchError('SEARCH_WAL_CHECKPOINT_INVALID');
  }
  return result;
}

export function getChatState(db: Database, chatId: string): SearchChatState | null {
  return db.query<SearchChatState, [string]>(`
    SELECT chat_id AS chatId, transcript_view_id AS transcriptViewId,
      status, phase, target_through AS targetThrough,
      processed_through AS processedThrough, active_chunk_id AS activeChunkId,
      slot_document_count AS slotDocumentCount, slot_token_count AS slotTokenCount,
      last_error_code AS lastErrorCode, updated_at AS updatedAt
    FROM search_chat_state WHERE chat_id = ?
  `).get(chatId) ?? null;
}

export function readActiveChunkBody(db: Database, expectedState: SearchChatState):
  | { readonly disposition: 'current'; readonly body: string }
  | { readonly disposition: 'superseded' } {
  const state = getChatState(db, expectedState.chatId);
  if (!sameState(state, expectedState)) return { disposition: 'superseded' };
  if (state.activeChunkId === null) throw searchError('SEARCH_STATE_INVARIANT');
  const chunk = db.query<{ body: string; chatId: string }, [number]>(`
    SELECT body, chat_id AS chatId FROM search_chunks WHERE id = ?
  `).get(state.activeChunkId);
  if (!chunk || chunk.chatId !== state.chatId) throw searchError('SEARCH_STATE_INVARIANT');
  return { disposition: 'current', body: chunk.body };
}

function readProgress(db: Database, chunkId: number): SearchChunkProgress | null {
  const row = db.query<SearchChunkProgress, [number]>(`
    SELECT chunk_id AS chunkId, complete,
      persisted_term_count AS persistedTermCount,
      persisted_occurrence_count AS persistedOccurrenceCount,
      persisted_term_bytes AS persistedTermBytes,
      persisted_position_bytes AS persistedPositionBytes,
      term_cursor AS termCursor
    FROM search_chunk_progress WHERE chunk_id = ?
  `).get(chunkId);
  return row ? {
    ...row,
    termCursor: row.termCursor === null ? null : Uint8Array.from(row.termCursor),
  } : null;
}

function readChunkWithProgress(db: Database, chunkId: number): ChunkWithProgress | null {
  const row = db.query<ChunkWithProgress, [number]>(`
    SELECT chunks.id, chunks.chat_id AS chatId,
      chunks.transcript_view_id AS transcriptViewId, chunks.ordinal,
      chunks.role, chunks.timestamp, chunks.body, chunks.body_bytes AS bodyBytes,
      chunks.token_count AS tokenCount, chunks.term_count AS termCount,
      chunks.term_bytes AS termBytes, chunks.position_bytes AS positionBytes,
      progress.chunk_id AS chunkId, progress.complete,
      progress.persisted_term_count AS persistedTermCount,
      progress.persisted_occurrence_count AS persistedOccurrenceCount,
      progress.persisted_term_bytes AS persistedTermBytes,
      progress.persisted_position_bytes AS persistedPositionBytes,
      progress.term_cursor AS termCursor
    FROM search_chunks AS chunks
    JOIN search_chunk_progress AS progress ON progress.chunk_id = chunks.id
    WHERE chunks.id = ?
  `).get(chunkId);
  return row ? {
    ...row,
    termCursor: row.termCursor === null ? null : Uint8Array.from(row.termCursor),
  } : null;
}

interface SlotChunkCursor {
  readonly id: number;
  readonly transcriptViewId: string;
  readonly ordinal: number;
}

function firstSlotChunk(db: Database, chatId: string): SlotChunkCursor | null {
  return db.query<SlotChunkCursor, [string]>(SEARCH_FIRST_SLOT_CHUNK_SQL).get(chatId) ?? null;
}

function nextViewChunk(
  db: Database,
  chatId: string,
  transcriptViewId: string,
  afterOrdinal: number,
): { readonly id: number; readonly ordinal: number; readonly complete: number } | null {
  return db.query<{
    id: number;
    ordinal: number;
    complete: number;
  }, [string, string, number]>(SEARCH_NEXT_VIEW_CHUNK_SQL).get(
    chatId,
    transcriptViewId,
    afterOrdinal,
  ) ?? null;
}

function nextIncompleteChunkId(
  db: Database,
  chatId: string,
  transcriptViewId: string,
  afterOrdinal: number,
): number | null {
  const next = nextViewChunk(db, chatId, transcriptViewId, afterOrdinal);
  if (next && next.complete !== 0) throw searchError('SEARCH_STATE_INVARIANT');
  return next?.id ?? null;
}

function subtractActiveSlot(db: Database, state: SearchChatState): void {
  if (state.status !== 'indexed' || state.phase !== 'idle') return;
  requireOneChange(db.query(`
    UPDATE search_corpus_stats
    SET document_count = document_count - ?, total_token_count = total_token_count - ?
    WHERE singleton = 1 AND document_count >= ? AND total_token_count >= ?
  `).run(
    state.slotDocumentCount,
    state.slotTokenCount,
    state.slotDocumentCount,
    state.slotTokenCount,
  ));
}

function planDisposition(state: SearchChatState): SyncPlanDisposition {
  if (state.status === 'indexed') return 'current';
  if (state.phase === 'replacement-cleanup' || state.phase === 'removal-cleanup') return 'cleanup';
  if (state.phase === 'replacement-checkpoint') return 'checkpoint';
  return 'build';
}

export function planReplacement(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly targetThrough: number;
}): SyncPlanResult {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (!isSafeNonNegative(input.targetThrough)) throw searchError('SEARCH_FRONTIER_INVALID');
  const current = getChatState(db, input.chatId);
  if (current?.status === 'indexed'
      && current.phase === 'idle'
      && current.transcriptViewId === input.transcriptViewId
      && current.processedThrough >= input.targetThrough
      && current.targetThrough >= input.targetThrough) {
    return { disposition: 'current', state: current };
  }
  return runTransaction(db, () => {
    const prior = getChatState(db, input.chatId);
    if (!prior) {
      const updatedAt = nextTimestamp();
      db.query(`
        INSERT INTO search_chat_state(
          chat_id, transcript_view_id, status, phase, target_through,
          processed_through, active_chunk_id, slot_document_count,
          slot_token_count, last_error_code, updated_at
        ) VALUES (?, ?, 'pending', 'replacement-build', ?, 0, NULL, 0, 0, NULL, ?)
      `).run(input.chatId, input.transcriptViewId, input.targetThrough, updatedAt);
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'build', state };
    }
    if (prior.status === 'indexed'
        && prior.phase === 'idle'
        && prior.transcriptViewId === input.transcriptViewId
        && prior.processedThrough >= input.targetThrough
        && prior.targetThrough >= input.targetThrough) {
      return { disposition: 'current', state: prior };
    }
    if (prior.transcriptViewId === input.transcriptViewId
        && prior.targetThrough === input.targetThrough
        && prior.status !== 'indexed') {
      if (prior.status === 'failed') {
        const updatedAt = nextTimestamp(prior.updatedAt);
        requireOneChange(db.query(`
          UPDATE search_chat_state SET status = 'pending', last_error_code = NULL, updated_at = ?
          WHERE ${STATE_MATCH_SQL}
        `).run(updatedAt, ...stateArguments(prior)));
      }
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: planDisposition(state), state };
    }
    if (prior.status === 'indexed'
        && prior.phase === 'idle'
        && prior.transcriptViewId === input.transcriptViewId
        && prior.processedThrough < input.targetThrough) {
      subtractActiveSlot(db, prior);
      const updatedAt = nextTimestamp(prior.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET status = 'pending', phase = 'append-build', target_through = ?,
          last_error_code = NULL, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(input.targetThrough, updatedAt, ...stateArguments(prior)));
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'build', state };
    }
    subtractActiveSlot(db, prior);
    const activeChunkId = firstSlotChunk(db, prior.chatId)?.id ?? null;
    const updatedAt = nextTimestamp(prior.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET transcript_view_id = ?, status = 'pending', phase = 'replacement-cleanup',
        target_through = ?, processed_through = 0, active_chunk_id = ?,
        last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(
      input.transcriptViewId,
      input.targetThrough,
      activeChunkId,
      updatedAt,
      ...stateArguments(prior),
    ));
    const state = getChatState(db, input.chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'cleanup', state };
  });
}

export function planAppend(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly expectedAfterOrdinal: number;
  readonly targetThrough: number;
}): SyncPlanResult {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (!isSafeNonNegative(input.expectedAfterOrdinal)
      || !isSafeNonNegative(input.targetThrough)
      || input.targetThrough < input.expectedAfterOrdinal) {
    throw searchError('SEARCH_FRONTIER_INVALID');
  }
  return runTransaction(db, () => {
    const prior = getChatState(db, input.chatId);
    if (!prior || prior.transcriptViewId !== input.transcriptViewId) {
      throw searchError('SEARCH_VIEW_MISMATCH');
    }
    if (prior.status === 'indexed' && prior.phase === 'idle'
        && prior.processedThrough >= input.targetThrough) {
      return { disposition: 'current', state: prior };
    }
    if (prior.status !== 'indexed'
        && prior.targetThrough === input.targetThrough
        && prior.processedThrough >= input.expectedAfterOrdinal
        && (prior.phase === 'append-build' || prior.phase === 'replacement-build')) {
      if (prior.status === 'failed') {
        const updatedAt = nextTimestamp(prior.updatedAt);
        requireOneChange(db.query(`
          UPDATE search_chat_state SET status = 'pending', last_error_code = NULL, updated_at = ?
          WHERE ${STATE_MATCH_SQL}
        `).run(updatedAt, ...stateArguments(prior)));
      }
      const state = getChatState(db, input.chatId);
      if (!state) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'build', state };
    }
    if (prior.status !== 'indexed' || prior.phase !== 'idle'
        || prior.processedThrough !== input.expectedAfterOrdinal) {
      throw searchError('SEARCH_INDEX_GAP');
    }
    subtractActiveSlot(db, prior);
    const updatedAt = nextTimestamp(prior.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'pending', phase = 'append-build', target_through = ?,
        last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(input.targetThrough, updatedAt, ...stateArguments(prior)));
    const state = getChatState(db, input.chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'build', state };
  });
}

function validateRawStageRows(
  expectedState: SearchChatState,
  rows: readonly HistoricalSearchMessageRow[],
  documents: readonly TokenizedDocument[],
): void {
  if (rows.length === 0 || rows.length > SEARCH_RAW_STAGE_MAX_ROWS
      || rows.length !== documents.length) {
    throw searchError('SEARCH_RAW_STAGE_INVALID');
  }
  let rawBytes = 0;
  let previousOrdinal = expectedState.processedThrough;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const document = documents[index]!;
    const bodyBytes = Buffer.byteLength(row.body, 'utf8');
    rawBytes += bodyBytes;
    if (!Number.isSafeInteger(row.ordinal)
        || row.ordinal <= previousOrdinal
        || row.ordinal > expectedState.targetThrough
        || !Object.hasOwn(ROLE_CODES, row.role)
        || !validBoundedText(row.body, SEARCH_RAW_STAGE_MAX_BYTES)
        || (row.timestamp !== null && !validBoundedText(row.timestamp, 256))
        || document.document !== index + 1
        || document.tokenCount < 1
        || document.termCount !== document.postings.length
        || document.termCount > document.tokenCount - 1
        || document.termBytes < document.termCount
        || document.positionBytes < document.tokenCount - 1) {
      throw searchError('SEARCH_RAW_STAGE_INVALID');
    }
    previousOrdinal = row.ordinal;
  }
  if (rawBytes > SEARCH_RAW_STAGE_MAX_BYTES) throw searchError('SEARCH_RAW_STAGE_INVALID');
}

export function stageRawChunks(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly rows: readonly HistoricalSearchMessageRow[];
  readonly documents: readonly TokenizedDocument[];
}): RawStageResult {
  validateRawStageRows(input.expectedState, input.rows, input.documents);
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.activeChunkId !== null) {
    throw searchError('SEARCH_RAW_STAGE_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    if (nextViewChunk(
      db,
      state.chatId,
      state.transcriptViewId,
      state.processedThrough,
    ) !== null) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const insertChunk = db.query(`
      INSERT INTO search_chunks(
        chat_id, transcript_view_id, ordinal, role, timestamp, body, body_bytes,
        token_count, term_count, term_bytes, position_bytes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const insertProgress = db.query(`
      INSERT INTO search_chunk_progress(
        chunk_id, complete, persisted_term_count, persisted_occurrence_count,
        persisted_term_bytes, persisted_position_bytes, term_cursor
      ) VALUES (?, 0, 0, 0, 0, 0, NULL)
    `);
    let firstId: number | null = null;
    for (let index = 0; index < input.rows.length; index += 1) {
      const row = input.rows[index]!;
      const document = input.documents[index]!;
      const inserted = insertChunk.get(
        state.chatId,
        state.transcriptViewId,
        row.ordinal,
        ROLE_CODES[row.role],
        row.timestamp,
        row.body,
        Buffer.byteLength(row.body, 'utf8'),
        document.tokenCount,
        document.termCount,
        document.termBytes,
        document.positionBytes,
      ) as { id: number } | null;
      const id = Number(inserted?.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw searchError('SEARCH_STATE_INVARIANT');
      firstId ??= id;
      insertProgress.run(id);
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state SET active_chunk_id = ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(firstId, updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'raw-staged', state: updated, acceptedRows: input.rows.length };
  });
}

function validateTokenizedDocument(chunk: ChunkWithProgress, document: TokenizedDocument): void {
  if (document.document !== 1
      || !Number.isSafeInteger(document.tokenCount)
      || document.tokenCount < 1
      || !Number.isSafeInteger(document.termCount)
      || document.termCount < 0
      || document.termCount > document.tokenCount - 1
      || !Number.isSafeInteger(document.termBytes)
      || document.termBytes < document.termCount
      || !Number.isSafeInteger(document.positionBytes)
      || document.positionBytes < document.tokenCount - 1
      || document.postings.length !== document.termCount) {
    throw searchError('SEARCH_POSTING_INVALID');
  }
  let occurrences = 0;
  let termBytes = 0;
  let positionBytes = 0;
  let previous: Uint8Array | null = null;
  for (const posting of document.postings) {
    if (posting.term.byteLength === 0 || posting.term.byteLength > 32_768
        || (previous !== null && compareSearchTerms(previous, posting.term) >= 0)) {
      throw searchError('SEARCH_POSTING_INVALID');
    }
    decodeCanonicalPositions({
      encoded: posting.positions,
      frequency: posting.frequency,
      maxPositionExclusive: document.tokenCount - 1,
    });
    occurrences += posting.frequency;
    termBytes += posting.term.byteLength;
    positionBytes += posting.positions.byteLength;
    previous = posting.term;
  }
  if (occurrences !== document.tokenCount - 1
      || termBytes !== document.termBytes
      || positionBytes !== document.positionBytes) {
    throw searchError('SEARCH_POSTING_INVALID');
  }
  if (document.tokenCount !== chunk.tokenCount
      || document.termCount !== chunk.termCount
      || document.termBytes !== chunk.termBytes
      || document.positionBytes !== chunk.positionBytes) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
}

function postingPrefix(
  document: TokenizedDocument,
  progress: SearchChunkProgress,
): {
  readonly selected: readonly TokenizedDocument['postings'][number][];
  readonly final: boolean;
  readonly prefixOccurrences: number;
  readonly prefixTermBytes: number;
  readonly prefixPositionBytes: number;
} {
  let start = 0;
  let prefixOccurrences = 0;
  let prefixTermBytes = 0;
  let prefixPositionBytes = 0;
  if (progress.termCursor !== null) {
    const cursorIndex = document.postings.findIndex(
      (posting) => compareSearchTerms(posting.term, progress.termCursor!) === 0,
    );
    if (cursorIndex < 0) throw searchError('SEARCH_INDEX_CORRUPT');
    start = cursorIndex + 1;
    for (const posting of document.postings.slice(0, start)) {
      prefixOccurrences += posting.frequency;
      prefixTermBytes += posting.term.byteLength;
      prefixPositionBytes += posting.positions.byteLength;
    }
  }
  if (start !== progress.persistedTermCount
      || prefixOccurrences !== progress.persistedOccurrenceCount
      || prefixTermBytes !== progress.persistedTermBytes
      || prefixPositionBytes !== progress.persistedPositionBytes) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
  const selected: TokenizedDocument['postings'][number][] = [];
  let selectedBytes = 0;
  for (const posting of document.postings.slice(start)) {
    const bytes = posting.term.byteLength + posting.positions.byteLength;
    if (selected.length >= SEARCH_TERM_STEP_MAX_ROWS
        || selectedBytes + bytes > SEARCH_TERM_STEP_MAX_BYTES) break;
    selected.push(posting);
    selectedBytes += bytes;
  }
  if (start < document.postings.length && selected.length === 0) {
    throw searchError('SEARCH_POSTING_INVALID');
  }
  return {
    selected,
    final: start + selected.length === document.postings.length,
    prefixOccurrences,
    prefixTermBytes,
    prefixPositionBytes,
  };
}

function requireDurablePostingCursor(
  db: Database,
  chunk: ChunkWithProgress,
  document: TokenizedDocument,
): void {
  const greatest = db.query<{
    term: Uint8Array;
    frequency: number;
    positions: Uint8Array;
  }, [number]>(SEARCH_GREATEST_PERSISTED_POSTING_SQL).get(chunk.id);
  if (chunk.persistedTermCount === 0) {
    if (greatest || chunk.termCursor !== null) throw searchError('SEARCH_INDEX_CORRUPT');
    return;
  }
  const expected = document.postings[chunk.persistedTermCount - 1];
  if (!greatest || !expected || chunk.termCursor === null
      || compareSearchTerms(greatest.term, chunk.termCursor) !== 0
      || compareSearchTerms(greatest.term, expected.term) !== 0
      || greatest.frequency !== expected.frequency
      || compareSearchTerms(greatest.positions, expected.positions) !== 0) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
}

function requireNoPersistedSuccessor(
  db: Database,
  chunkId: number,
  greatestExpectedTerm: Uint8Array | undefined,
): void {
  if (!greatestExpectedTerm) {
    const any = db.query<{ present: number }, [number]>(`
      SELECT EXISTS(SELECT 1 FROM search_chunk_terms WHERE chunk_id = ?) AS present
    `).get(chunkId)?.present;
    if (Number(any) !== 0) throw searchError('SEARCH_INDEX_CORRUPT');
    return;
  }
  const successor = db.query<{ term: Uint8Array }, [number, Uint8Array]>(
    SEARCH_PERSISTED_SUCCESSOR_SQL,
  ).get(chunkId, greatestExpectedTerm);
  if (successor) throw searchError('SEARCH_INDEX_CORRUPT');
}

export function buildTermStep(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly document: TokenizedDocument;
}): TermBuildResult {
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.activeChunkId === null) {
    throw searchError('SEARCH_TERM_BUILD_INVALID');
  }
  const initialState = getChatState(db, input.expectedState.chatId);
  if (!sameState(initialState, input.expectedState)) return { disposition: 'superseded' };
  const initialChunk = readChunkWithProgress(db, input.expectedState.activeChunkId);
  if (!initialChunk || initialChunk.chatId !== input.expectedState.chatId
      || initialChunk.transcriptViewId !== input.expectedState.transcriptViewId
      || initialChunk.complete !== 0) {
    throw searchError('SEARCH_STATE_INVARIANT');
  }
  validateTokenizedDocument(initialChunk, input.document);
  const selection = postingPrefix(input.document, initialChunk);
  requireDurablePostingCursor(db, initialChunk, input.document);
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    const chunk = readChunkWithProgress(db, input.expectedState.activeChunkId!);
    if (!chunk || !sameProgress(chunk, initialChunk)
        || chunk.body !== initialChunk.body
        || chunk.tokenCount !== initialChunk.tokenCount
        || chunk.termCount !== initialChunk.termCount
        || chunk.termBytes !== initialChunk.termBytes
        || chunk.positionBytes !== initialChunk.positionBytes) {
      return { disposition: 'superseded' };
    }
    requireDurablePostingCursor(db, chunk, input.document);
    let insertedOccurrences = 0;
    let insertedTermBytes = 0;
    let insertedPositionBytes = 0;
    const insert = db.query(`
      INSERT INTO search_chunk_terms(chunk_id, chat_id, term, frequency, positions)
      SELECT chunks.id, chunks.chat_id, ?, ?, ?
      FROM search_chunks AS chunks
      WHERE chunks.id = ? AND chunks.chat_id = ? AND chunks.transcript_view_id = ?
    `);
    for (const posting of selection.selected) {
      const result = insert.run(
        posting.term,
        posting.frequency,
        posting.positions,
        chunk.id,
        state.chatId,
        state.transcriptViewId,
      );
      requireOneChange(result);
      insertedOccurrences += posting.frequency;
      insertedTermBytes += posting.term.byteLength;
      insertedPositionBytes += posting.positions.byteLength;
    }
    const persistedTermCount = chunk.persistedTermCount + selection.selected.length;
    const persistedOccurrenceCount = chunk.persistedOccurrenceCount + insertedOccurrences;
    const persistedTermBytes = chunk.persistedTermBytes + insertedTermBytes;
    const persistedPositionBytes = chunk.persistedPositionBytes + insertedPositionBytes;
    const termCursor = selection.selected.at(-1)?.term ?? chunk.termCursor;
    if (selection.final
        && (persistedTermCount !== chunk.termCount
          || persistedOccurrenceCount !== chunk.tokenCount - 1
          || persistedTermBytes !== chunk.termBytes
          || persistedPositionBytes !== chunk.positionBytes)) {
      throw searchError('SEARCH_INDEX_CORRUPT');
    }
    if (selection.final) {
      requireNoPersistedSuccessor(db, chunk.id, input.document.postings.at(-1)?.term);
    }
    requireOneChange(db.query(`
      UPDATE search_chunk_progress
      SET complete = ?, persisted_term_count = ?, persisted_occurrence_count = ?,
        persisted_term_bytes = ?, persisted_position_bytes = ?, term_cursor = ?
      WHERE ${PROGRESS_MATCH_SQL}
    `).run(
      selection.final ? 1 : 0,
      persistedTermCount,
      persistedOccurrenceCount,
      persistedTermBytes,
      persistedPositionBytes,
      termCursor,
      ...progressArguments(chunk),
    ));
    let updatedState = state;
    if (selection.final) {
      const nextActiveChunkId = nextIncompleteChunkId(
        db,
        state.chatId,
        state.transcriptViewId,
        chunk.ordinal,
      );
      const updatedAt = nextTimestamp(state.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET processed_through = ?, active_chunk_id = ?,
          slot_document_count = slot_document_count + 1,
          slot_token_count = slot_token_count + ?, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(
        chunk.ordinal,
        nextActiveChunkId,
        chunk.tokenCount,
        updatedAt,
        ...stateArguments(state),
      ));
      const read = getChatState(db, state.chatId);
      if (!read) throw searchError('SEARCH_STATE_INVARIANT');
      updatedState = read;
    }
    return {
      disposition: 'term-progress',
      state: updatedState,
      insertedTerms: selection.selected.length,
      insertedOccurrences,
      completedChunk: selection.final,
    };
  });
}

export function advanceFrontier(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly throughOrdinal: number;
}): FrontierResult {
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.activeChunkId !== null
      || !Number.isSafeInteger(input.throughOrdinal)
      || input.throughOrdinal <= input.expectedState.processedThrough
      || input.throughOrdinal > input.expectedState.targetThrough) {
    throw searchError('SEARCH_FRONTIER_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    if (nextViewChunk(
      db,
      state.chatId,
      state.transcriptViewId,
      state.processedThrough,
    ) !== null) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state SET processed_through = ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(input.throughOrdinal, updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'frontier-progress', state: updated };
  });
}

export function activateChat(db: Database, input: {
  readonly expectedState: SearchChatState;
}): ActivationResult {
  if (input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)
      || input.expectedState.processedThrough !== input.expectedState.targetThrough
      || input.expectedState.activeChunkId !== null) {
    throw searchError('SEARCH_ACTIVATION_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) return { disposition: 'superseded' };
    requireOneChange(db.query(`
      UPDATE search_corpus_stats
      SET document_count = document_count + ?, total_token_count = total_token_count + ?
      WHERE singleton = 1
    `).run(state.slotDocumentCount, state.slotTokenCount));
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'indexed', phase = 'idle', last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'indexed', state: updated };
  });
}

export function startRemoval(db: Database, chatId: string): SyncPlanResult | {
  readonly disposition: 'chat-deleted'; readonly chatId: string;
} {
  requireIdentifier(chatId);
  const current = getChatState(db, chatId);
  if (!current) return { disposition: 'chat-deleted', chatId };
  if (current.status === 'pending' && current.phase === 'removal-cleanup') {
    return { disposition: 'cleanup', state: current };
  }
  return runTransaction(db, () => {
    const prior = getChatState(db, chatId);
    if (!prior) return { disposition: 'chat-deleted' as const, chatId };
    if (prior.status === 'pending' && prior.phase === 'removal-cleanup') {
      return { disposition: 'cleanup' as const, state: prior };
    }
    subtractActiveSlot(db, prior);
    const activeChunkId = firstSlotChunk(db, chatId)?.id ?? null;
    const updatedAt = nextTimestamp(prior.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'pending', phase = 'removal-cleanup', active_chunk_id = ?,
        last_error_code = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(activeChunkId, updatedAt, ...stateArguments(prior)));
    const state = getChatState(db, chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'cleanup' as const, state };
  });
}

function deleteTermBatch(
  db: Database,
  state: SearchChatState,
  chunk: ChunkWithProgress,
): CleanupResult {
  const candidates = db.query<{
    term: Uint8Array;
    frequency: number;
    positions: Uint8Array;
  }, [number, number]>(`
    SELECT term, frequency, positions FROM search_chunk_terms
    WHERE chunk_id = ? ORDER BY term DESC LIMIT ?
  `).all(chunk.id, SEARCH_TERM_STEP_MAX_ROWS);
  const selected: typeof candidates = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const rowBytes = candidate.term.byteLength + candidate.positions.byteLength;
    if (selected.length > 0 && bytes + rowBytes > SEARCH_TERM_STEP_MAX_BYTES) break;
    if (rowBytes > SEARCH_TERM_STEP_MAX_BYTES) throw searchError('SEARCH_INDEX_CORRUPT');
    selected.push(candidate);
    bytes += rowBytes;
  }
  if (selected.length === 0) throw searchError('SEARCH_STATE_INVARIANT');
  if (chunk.termCursor === null
      || compareSearchTerms(selected[0]!.term, chunk.termCursor) !== 0
      || selected.length > chunk.persistedTermCount) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
  let occurrences = 0;
  let termBytes = 0;
  let positionBytes = 0;
  const remove = db.query('DELETE FROM search_chunk_terms WHERE chunk_id = ? AND term = ?');
  for (const term of selected) {
    try {
      decodeCanonicalPositions({
        encoded: term.positions,
        frequency: term.frequency,
        maxPositionExclusive: chunk.tokenCount - 1,
      });
    } catch {
      throw searchError('SEARCH_INDEX_CORRUPT');
    }
    requireOneChange(remove.run(chunk.id, term.term));
    occurrences += term.frequency;
    termBytes += term.term.byteLength;
    positionBytes += term.positions.byteLength;
  }
  const remaining = db.query<{ term: Uint8Array }, [number]>(`
    SELECT term FROM search_chunk_terms WHERE chunk_id = ? ORDER BY term DESC LIMIT 1
  `).get(chunk.id)?.term ?? null;
  const remainingTermCount = chunk.persistedTermCount - selected.length;
  if (occurrences > chunk.persistedOccurrenceCount
      || termBytes > chunk.persistedTermBytes
      || positionBytes > chunk.persistedPositionBytes
      || (remainingTermCount === 0) !== (remaining === null)) {
    throw searchError('SEARCH_INDEX_CORRUPT');
  }
  const wasComplete = chunk.complete === 1;
  requireOneChange(db.query(`
    UPDATE search_chunk_progress
    SET complete = 0,
      persisted_term_count = persisted_term_count - ?,
      persisted_occurrence_count = persisted_occurrence_count - ?,
      persisted_term_bytes = persisted_term_bytes - ?,
      persisted_position_bytes = persisted_position_bytes - ?,
      term_cursor = ?
    WHERE ${PROGRESS_MATCH_SQL}
  `).run(
    selected.length,
    occurrences,
    termBytes,
    positionBytes,
    remaining,
    ...progressArguments(chunk),
  ));
  let updatedState = state;
  if (wasComplete) {
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET slot_document_count = slot_document_count - 1,
        slot_token_count = slot_token_count - ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
        AND slot_document_count > 0 AND slot_token_count >= ?
    `).run(chunk.tokenCount, updatedAt, ...stateArguments(state), chunk.tokenCount));
    const read = getChatState(db, state.chatId);
    if (!read) throw searchError('SEARCH_STATE_INVARIANT');
    updatedState = read;
  }
  return {
    disposition: 'cleanup-progress',
    state: updatedState,
    deletedTerms: selected.length,
    deletedRows: 0,
    deletedBodyBytes: 0,
  };
}

function deleteRawBatch(
  db: Database,
  state: SearchChatState,
  first: ChunkWithProgress,
): CleanupResult {
  const candidates = db.query<ChunkWithProgress, [string, string, number]>(
    SEARCH_RAW_DELETE_CANDIDATES_SQL,
  ).all(state.chatId, first.transcriptViewId, first.ordinal).map((row) => ({
    ...row,
    termCursor: row.termCursor === null ? null : Uint8Array.from(row.termCursor),
  }));
  const selected: ChunkWithProgress[] = [];
  let bodyBytes = 0;
  for (const candidate of candidates) {
    if (candidate.persistedTermCount !== 0 || candidate.termCursor !== null) break;
    if (selected.length > 0 && bodyBytes + candidate.bodyBytes > SEARCH_RAW_STAGE_MAX_BYTES) break;
    if (candidate.bodyBytes > SEARCH_RAW_STAGE_MAX_BYTES) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const hasTerms = Number(db.query<{ present: number }, [number]>(
      SEARCH_CHUNK_HAS_TERMS_SQL,
    ).get(candidate.id)?.present ?? -1);
    if (hasTerms !== 0) throw searchError('SEARCH_INDEX_CORRUPT');
    selected.push(candidate);
    bodyBytes += candidate.bodyBytes;
  }
  if (selected.length === 0 || selected[0]!.id !== first.id) {
    throw searchError('SEARCH_STATE_INVARIANT');
  }
  let slotDocuments = state.slotDocumentCount;
  let slotTokens = state.slotTokenCount;
  for (const candidate of selected) {
    if (candidate.complete === 1) {
      slotDocuments -= 1;
      slotTokens -= candidate.tokenCount;
    }
    requireOneChange(db.query(`
      DELETE FROM search_chunk_progress WHERE ${PROGRESS_MATCH_SQL}
    `).run(...progressArguments(candidate)));
    requireOneChange(db.query('DELETE FROM search_chunks WHERE id = ? AND chat_id = ?')
      .run(candidate.id, state.chatId));
  }
  if (slotDocuments < 0 || slotTokens < slotDocuments) {
    throw searchError('SEARCH_STATE_INVARIANT');
  }
  const nextActiveChunkId = firstSlotChunk(db, state.chatId)?.id ?? null;
  const updatedAt = nextTimestamp(state.updatedAt);
  requireOneChange(db.query(`
    UPDATE search_chat_state
    SET active_chunk_id = ?, slot_document_count = ?, slot_token_count = ?, updated_at = ?
    WHERE ${STATE_MATCH_SQL}
  `).run(
    nextActiveChunkId,
    slotDocuments,
    slotTokens,
    updatedAt,
    ...stateArguments(state),
  ));
  const updated = getChatState(db, state.chatId);
  if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
  return {
    disposition: 'cleanup-progress',
    state: updated,
    deletedTerms: 0,
    deletedRows: selected.length,
    deletedBodyBytes: bodyBytes,
  };
}

export function cleanupStep(db: Database, input: {
  readonly expectedState: SearchChatState;
}): CleanupResult {
  if (input.expectedState.status !== 'pending'
      || !['replacement-cleanup', 'removal-cleanup'].includes(input.expectedState.phase)) {
    throw searchError('SEARCH_CLEANUP_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) {
      return { disposition: 'superseded', chatId: input.expectedState.chatId };
    }
    if (state.activeChunkId === null) {
      if (firstSlotChunk(db, state.chatId) !== null
          || state.slotDocumentCount !== 0 || state.slotTokenCount !== 0) {
        throw searchError('SEARCH_STATE_INVARIANT');
      }
      if (state.phase === 'removal-cleanup') {
        requireOneChange(db.query(`DELETE FROM search_chat_state WHERE ${STATE_MATCH_SQL}`)
          .run(...stateArguments(state)));
        return { disposition: 'chat-deleted', chatId: state.chatId };
      }
      const updatedAt = nextTimestamp(state.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET phase = 'replacement-checkpoint', active_chunk_id = NULL, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(updatedAt, ...stateArguments(state)));
      const updated = getChatState(db, state.chatId);
      if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
      return { disposition: 'replacement-checkpoint', state: updated };
    }
    const chunk = readChunkWithProgress(db, state.activeChunkId);
    if (!chunk || chunk.chatId !== state.chatId) throw searchError('SEARCH_STATE_INVARIANT');
    if (chunk.persistedTermCount > 0) return deleteTermBatch(db, state, chunk);
    return deleteRawBatch(db, state, chunk);
  });
}

export function completeReplacementCheckpoint(db: Database, input: {
  readonly expectedState: SearchChatState;
}): SyncPlanResult | { readonly disposition: 'superseded'; readonly state: SearchChatState } {
  if (input.expectedState.status !== 'pending'
      || input.expectedState.phase !== 'replacement-checkpoint') {
    throw searchError('SEARCH_CHECKPOINT_STATE_INVALID');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) {
      return { disposition: 'superseded' as const, state: input.expectedState };
    }
    if (firstSlotChunk(db, state.chatId) !== null
        || state.slotDocumentCount !== 0 || state.slotTokenCount !== 0) {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET phase = 'replacement-build', processed_through = 0,
        active_chunk_id = NULL, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(updatedAt, ...stateArguments(state)));
    const updated = getChatState(db, state.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return { disposition: 'build' as const, state: updated };
  });
}

export function markChatFailed(db: Database, input: {
  readonly expectedState: SearchChatState;
  readonly errorCode: string;
}): FailureRecordResult {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)
      || input.expectedState.status !== 'pending'
      || !['append-build', 'replacement-build'].includes(input.expectedState.phase)) {
    throw searchError('INVALID_SEARCH_ERROR_CODE');
  }
  return runTransaction(db, () => {
    const state = getChatState(db, input.expectedState.chatId);
    if (!sameState(state, input.expectedState)) {
      return { disposition: 'failure-recorded', applied: false };
    }
    const updatedAt = nextTimestamp(state.updatedAt);
    requireOneChange(db.query(`
      UPDATE search_chat_state
      SET status = 'failed', last_error_code = ?, updated_at = ?
      WHERE ${STATE_MATCH_SQL}
    `).run(input.errorCode, updatedAt, ...stateArguments(state)));
    return { disposition: 'failure-recorded', applied: true };
  });
}

export function markPrunedChats(db: Database, input: {
  readonly allowedChatIds: readonly string[];
  readonly afterChatId: string | null;
}): PruneMarkResult {
  if (!Array.isArray(input.allowedChatIds) || input.allowedChatIds.length > 10_000
      || input.allowedChatIds.some((chatId) => {
        try { requireIdentifier(chatId); return false; } catch { return true; }
      })
      || (input.afterChatId !== null && !validBoundedText(input.afterChatId, 256))) {
    throw searchError('SEARCH_PRUNE_INVALID');
  }
  const allowed = JSON.stringify([...new Set(input.allowedChatIds)]);
  return runTransaction(db, () => {
    const states = db.query<SearchChatState, [string, number]>(`
      SELECT chat_id AS chatId, transcript_view_id AS transcriptViewId,
        status, phase, target_through AS targetThrough,
        processed_through AS processedThrough, active_chunk_id AS activeChunkId,
        slot_document_count AS slotDocumentCount, slot_token_count AS slotTokenCount,
        last_error_code AS lastErrorCode, updated_at AS updatedAt
      FROM search_chat_state
      WHERE chat_id > ? ORDER BY chat_id LIMIT ?
    `).all(input.afterChatId ?? '', SEARCH_PRUNE_MAX_STATES);
    const cleanups: PrunedChatCleanup[] = [];
    let subtractedDocuments = 0;
    let subtractedTokens = 0;
    for (const prior of states) {
      const present = Number(db.query<{ present: number }, [string, string]>(`
        SELECT EXISTS(
          SELECT 1 FROM json_each(?) WHERE CAST(value AS TEXT) = ?
        ) AS present
      `).get(allowed, prior.chatId)?.present ?? 0) === 1;
      if (present) continue;
      if (prior.status === 'pending' && prior.phase === 'removal-cleanup') {
        cleanups.push({ expectedState: prior });
        continue;
      }
      if (prior.status === 'indexed' && prior.phase === 'idle') {
        subtractedDocuments += prior.slotDocumentCount;
        subtractedTokens += prior.slotTokenCount;
      }
      const activeChunkId = firstSlotChunk(db, prior.chatId)?.id ?? null;
      const updatedAt = nextTimestamp(prior.updatedAt);
      requireOneChange(db.query(`
        UPDATE search_chat_state
        SET status = 'pending', phase = 'removal-cleanup', active_chunk_id = ?,
          last_error_code = NULL, updated_at = ?
        WHERE ${STATE_MATCH_SQL}
      `).run(activeChunkId, updatedAt, ...stateArguments(prior)));
      const updated = getChatState(db, prior.chatId);
      if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
      cleanups.push({ expectedState: updated });
    }
    if (subtractedDocuments > 0 || subtractedTokens > 0) {
      requireOneChange(db.query(SEARCH_PRUNE_CORPUS_SUBTRACT_SQL).run(
        subtractedDocuments,
        subtractedTokens,
        subtractedDocuments,
        subtractedTokens,
      ));
    }
    const done = states.length < SEARCH_PRUNE_MAX_STATES;
    return {
      disposition: 'prune-progress',
      cleanups,
      nextAfterChatId: done ? null : states.at(-1)!.chatId,
      done,
    };
  });
}
