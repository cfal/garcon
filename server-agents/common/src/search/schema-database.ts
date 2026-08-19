import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { compareSearchTerms } from './tokenizer.js';

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
export const SEARCH_SCHEMA_SQL_SHA256 =
  'f145dd5094386f487d77762af6dd1417c3643a01214239009a0f88d40ee74797';

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

export interface SearchChunkRow {
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

export interface SearchChunkProgress {
  readonly chunkId: number;
  readonly complete: number;
  readonly persistedTermCount: number;
  readonly persistedOccurrenceCount: number;
  readonly persistedTermBytes: number;
  readonly persistedPositionBytes: number;
  readonly termCursor: Uint8Array | null;
}

export interface ChunkWithProgress extends SearchChunkRow, SearchChunkProgress {}

export type SearchSqlBinding = string | number | null | Uint8Array;

export const ROLE_CODES = { user: 0, assistant: 1, tool: 2, system: 3 } as const;
export const STATE_MATCH_SQL = `
  chat_id = ? AND transcript_view_id = ? AND status = ? AND phase = ?
  AND target_through = ? AND processed_through = ? AND active_chunk_id IS ?
  AND slot_document_count = ? AND slot_token_count = ? AND last_error_code IS ?
  AND updated_at = ?
`;
export const PROGRESS_MATCH_SQL = `
  chunk_id = ? AND complete = ? AND persisted_term_count = ?
  AND persisted_occurrence_count = ? AND persisted_term_bytes = ?
  AND persisted_position_bytes = ? AND term_cursor IS ?
`;

export function searchError(code: string): Error {
  return new Error(code);
}

export function isSafeNonNegative(value: number): boolean {
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

export function validBoundedText(value: string, maximumBytes: number, allowEmpty = false): boolean {
  return typeof value === 'string'
    && (allowEmpty || value.length > 0)
    && hasWellFormedUtf16(value)
    && Buffer.byteLength(value, 'utf8') <= maximumBytes;
}

export function requireIdentifier(value: string): void {
  if (!validBoundedText(value, 256)) throw searchError('SEARCH_IDENTIFIER_INVALID');
}

function requireFingerprint(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw searchError('SEARCH_TOKENIZER_FINGERPRINT_INVALID');
  }
}

export function stateArguments(state: SearchChatState): readonly SearchSqlBinding[] {
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

export function progressArguments(progress: SearchChunkProgress): readonly SearchSqlBinding[] {
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

export function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return compareSearchTerms(left, right) === 0;
}

export function sameState(
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

export function sameProgress(left: SearchChunkProgress, right: SearchChunkProgress): boolean {
  return left.chunkId === right.chunkId
    && left.complete === right.complete
    && left.persistedTermCount === right.persistedTermCount
    && left.persistedOccurrenceCount === right.persistedOccurrenceCount
    && left.persistedTermBytes === right.persistedTermBytes
    && left.persistedPositionBytes === right.persistedPositionBytes
    && sameBytes(left.termCursor, right.termCursor);
}

export function nextTimestamp(previous?: string): string {
  const now = Date.now();
  const prior = previous === undefined ? Number.NaN : Date.parse(previous);
  return new Date(Number.isFinite(prior) && prior >= now ? prior + 1 : now).toISOString();
}

export function runTransaction<T>(db: Database, work: () => T): T {
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

export function requireOneChange(result: { readonly changes: number }): void {
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

function validateSchemaSql(db: Database): void {
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
  const actual = createHash('sha256').update(payload).digest('hex');
  if (actual !== SEARCH_SCHEMA_SQL_SHA256) throw searchError('SEARCH_SCHEMA_LAYOUT_INVALID');
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
  validateSchemaSql(db);
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

function recreatableSchemaFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === 'SEARCH_SCHEMA_LAYOUT_INVALID'
      || error.message === 'SEARCH_SCHEMA_VERSION_INVALID'
      || error.message === 'SEARCH_TOKENIZER_FINGERPRINT_MISMATCH') {
    return true;
  }
  const code = String((error as Error & { readonly code?: unknown }).code ?? '');
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'SQLITE_SCHEMA') {
    return true;
  }
  return code === 'SQLITE_ERROR'
    && /^(?:no such table: search_index_metadata|no such column: tokenizer_fingerprint|malformed database schema)/i
      .test(error.message);
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
  const db = new Database(dbPath);
  try {
    validateExistingSchema(db, options.tokenizerFingerprint);
  } catch (error) {
    db.close(false);
    if (!recreatableSchemaFailure(error)) throw error;
    await unlinkDatabaseFiles(dbPath);
    return createFreshDatabase(dbPath, options.tokenizerFingerprint);
  }
  try {
    configureWriteConnection(db);
    validateExistingSchema(db, options.tokenizerFingerprint);
    await protectDatabaseFiles(dbPath);
    return { db, dbPath, recreated: false };
  } catch (error) {
    db.close(false);
    throw error;
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

export function readProgress(db: Database, chunkId: number): SearchChunkProgress | null {
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

export function readChunkWithProgress(db: Database, chunkId: number): ChunkWithProgress | null {
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

export function firstSlotChunk(db: Database, chatId: string): SlotChunkCursor | null {
  return db.query<SlotChunkCursor, [string]>(SEARCH_FIRST_SLOT_CHUNK_SQL).get(chatId) ?? null;
}

export function nextViewChunk(
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

export function nextIncompleteChunkId(
  db: Database,
  chatId: string,
  transcriptViewId: string,
  afterOrdinal: number,
): number | null {
  const next = nextViewChunk(db, chatId, transcriptViewId, afterOrdinal);
  if (next && next.complete !== 0) throw searchError('SEARCH_STATE_INVARIANT');
  return next?.id ?? null;
}

export function subtractActiveSlot(db: Database, state: SearchChatState): void {
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
