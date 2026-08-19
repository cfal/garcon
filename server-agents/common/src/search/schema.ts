import { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoricalSearchMessageRow } from './rows.js';

export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 9;
export const SEARCH_INGEST_TXN_MAX_ROWS = 256;
export const SEARCH_INGEST_TXN_MAX_BYTES = 1_048_576;
export const SEARCH_INGEST_ROW_MAX_BYTES = 1_048_576;
export const SEARCH_TIMESTAMP_MAX_BYTES = 256;
export const SEARCH_DELETE_BATCH_MAX_ROWS = 512;
export const SEARCH_FTS_CRISISMERGE = 1_000;
export const SEARCH_FTS_AUTOMERGE = 4;
export const SEARCH_FTS_MERGE_PAGES_PER_TXN = 16;
export const SEARCH_FTS_RANK = 'bm25(1.0)';

export type SearchChatStatus = 'pending' | 'indexed' | 'failed';

export interface SearchDatabase {
  readonly db: Database;
  readonly dbPath: string;
  readonly recreated: boolean;
}

export interface SearchChatState {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly status: SearchChatStatus;
  readonly indexedThrough: number;
  readonly targetThrough: number;
  readonly lastErrorCode: string | null;
}

export interface SearchStatusCounts {
  readonly indexed: number;
  readonly pending: number;
  readonly failed: number;
  readonly backlogRows: number;
}

export type SearchSyncPlan =
  | { readonly plan: 'current'; readonly state: SearchChatState }
  | { readonly plan: 'build'; readonly state: SearchChatState; readonly staleRows: boolean };

interface SearchSchemaObject {
  readonly masterType: 'table' | 'trigger';
  readonly sql: string;
}

const ROLE_CODES = { user: 0, assistant: 1, tool: 2, system: 3 } as const;

export const SEARCH_FTS_SHADOW_TABLES: ReadonlySet<string> = new Set([
  'search_chunks_fts_data',
  'search_chunks_fts_idx',
  'search_chunks_fts_config',
]);

const SEARCH_SCHEMA_OBJECT_SQL: ReadonlyMap<string, SearchSchemaObject> = new Map([
  ['search_chat_state', { masterType: 'table', sql: `CREATE TABLE search_chat_state (
  chat_id            TEXT PRIMARY KEY,
  transcript_view_id TEXT NOT NULL,
  status             TEXT NOT NULL CHECK(status IN ('pending', 'indexed', 'failed')),
  indexed_through    INTEGER NOT NULL CHECK(indexed_through >= 0),
  target_through     INTEGER NOT NULL CHECK(target_through >= 0),
  last_error_code    TEXT,
  updated_at         TEXT NOT NULL,
  CHECK(status <> 'indexed' OR indexed_through = target_through),
  CHECK(status <> 'pending' OR indexed_through <= target_through)
) WITHOUT ROWID, STRICT` }],
  ['search_chunks', { masterType: 'table', sql: `CREATE TABLE search_chunks (
  id                 INTEGER PRIMARY KEY,
  chat_id            TEXT NOT NULL REFERENCES search_chat_state(chat_id) ON DELETE CASCADE,
  transcript_view_id TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  role               INTEGER NOT NULL CHECK(role IN (0, 1, 2, 3)),
  timestamp          TEXT CHECK(
    timestamp IS NULL OR length(CAST(timestamp AS BLOB)) <= ${SEARCH_TIMESTAMP_MAX_BYTES}
  ),
  body               TEXT NOT NULL,
  UNIQUE(chat_id, transcript_view_id, ordinal)
) STRICT` }],
  ['search_chunks_fts', { masterType: 'table', sql: `CREATE VIRTUAL TABLE search_chunks_fts USING fts5(
  body,
  content='search_chunks',
  content_rowid='id',
  columnsize=0,
  tokenize='unicode61 remove_diacritics 2'
)` }],
  ['search_chunks_ai', { masterType: 'trigger', sql: `CREATE TRIGGER search_chunks_ai AFTER INSERT ON search_chunks BEGIN
  INSERT INTO search_chunks_fts(rowid, body)
  VALUES (new.id, new.body);
END` }],
  ['search_chunks_ad', { masterType: 'trigger', sql: `CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
  INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body)
  VALUES ('delete', old.id, old.body);
END` }],
  ['search_chunks_au', { masterType: 'trigger', sql: `CREATE TRIGGER search_chunks_au AFTER UPDATE OF body ON search_chunks BEGIN
  INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body)
  VALUES ('delete', old.id, old.body);
  INSERT INTO search_chunks_fts(rowid, body)
  VALUES (new.id, new.body);
END` }],
]);

function searchError(code: string): Error {
  return new Error(code);
}

function runTransaction<T>(db: Database, work: () => T): T {
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

function requireIdentifier(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 256) {
    throw searchError('SEARCH_IDENTIFIER_INVALID');
  }
}

function normalizeDdl(sql: string): string {
  return sql.replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim();
}

export function requireExactShadowSet(shadows: ReadonlySet<string>): void {
  if (shadows.size !== SEARCH_FTS_SHADOW_TABLES.size) {
    throw searchError('SEARCH_SCHEMA_INVALID');
  }
  for (const name of SEARCH_FTS_SHADOW_TABLES) {
    if (!shadows.has(name)) throw searchError('SEARCH_SCHEMA_INVALID');
  }
}

export function configureConnection(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

export function createSchema(db: Database): void {
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  for (const object of SEARCH_SCHEMA_OBJECT_SQL.values()) db.exec(object.sql);
  const configure = db.prepare<unknown, [string, string | number]>(
    'INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES (?, ?)',
  );
  try {
    configure.run('secure-delete', 1);
    configure.run('rank', SEARCH_FTS_RANK);
    configure.run('crisismerge', SEARCH_FTS_CRISISMERGE);
    configure.run('automerge', SEARCH_FTS_AUTOMERGE);
  } finally {
    configure.finalize();
  }
  db.exec(`PRAGMA user_version = ${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`);
}

function validateExistingSchema(db: Database): void {
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version')
    .get()?.user_version;
  if (version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION) throw searchError('SEARCH_SCHEMA_INVALID');
  const autoVacuum = db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum')
    .get()?.auto_vacuum;
  if (autoVacuum !== 2) throw searchError('SEARCH_SCHEMA_INVALID');

  const shadows = new Set(
    db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'",
    ).all().map((row) => row.name),
  );
  requireExactShadowSet(shadows);

  const objects = db.query<{ type: string; name: string; sql: string | null }, []>(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT GLOB 'sqlite_*'
    ORDER BY name
  `).all();
  let matched = 0;
  for (const object of objects) {
    if (shadows.has(object.name)) continue;
    const expected = SEARCH_SCHEMA_OBJECT_SQL.get(object.name);
    if (!expected
        || object.type !== expected.masterType
        || object.sql === null
        || normalizeDdl(object.sql) !== normalizeDdl(expected.sql)) {
      throw searchError('SEARCH_SCHEMA_INVALID');
    }
    matched += 1;
  }
  if (matched !== SEARCH_SCHEMA_OBJECT_SQL.size) throw searchError('SEARCH_SCHEMA_INVALID');

  const config = new Map(
    db.query<{ k: string; v: string | number }, []>(
      'SELECT k, v FROM search_chunks_fts_config',
    ).all().map((row) => [row.k, row.v]),
  );
  if (Number(config.get('crisismerge')) !== SEARCH_FTS_CRISISMERGE
      || Number(config.get('automerge')) !== SEARCH_FTS_AUTOMERGE
      || Number(config.get('secure-delete')) !== 1
      || config.get('rank') !== SEARCH_FTS_RANK) {
    throw searchError('SEARCH_SCHEMA_INVALID');
  }
}

async function unlinkDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => fs.rm(file, { force: true })),
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

async function createFreshDatabase(dbPath: string): Promise<SearchDatabase> {
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    configureConnection(db);
    createSchema(db);
    await protectDatabaseFiles(dbPath);
    return { db, dbPath, recreated: true };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function openSearchDatabase(dbPath: string): Promise<SearchDatabase> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const exists = await fs.stat(dbPath)
    .then((entry) => entry.isFile() && entry.size > 0)
    .catch(() => false);
  if (!exists) return createFreshDatabase(dbPath);
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    configureConnection(db);
    validateExistingSchema(db);
    await protectDatabaseFiles(dbPath);
    return { db, dbPath, recreated: false };
  } catch {
    db?.close();
    await unlinkDatabaseFiles(dbPath);
    return createFreshDatabase(dbPath);
  }
}

export function openSearchReadDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA temp_store = MEMORY');
    validateExistingSchema(db);
    const tempStore = db.query<{ temp_store: number }, []>('PRAGMA temp_store').get()?.temp_store;
    if (tempStore !== 2) throw searchError('SEARCH_SCHEMA_INVALID');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeSearchDatabase(db: Database): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export function getChatState(db: Database, chatId: string): SearchChatState | null {
  return db.query<SearchChatState, [string]>(`
    SELECT chat_id AS chatId, transcript_view_id AS transcriptViewId, status,
      indexed_through AS indexedThrough, target_through AS targetThrough,
      last_error_code AS lastErrorCode
    FROM search_chat_state WHERE chat_id = ?
  `).get(chatId) ?? null;
}

export function listChatStates(db: Database): SearchChatState[] {
  return db.query<SearchChatState, []>(`
    SELECT chat_id AS chatId, transcript_view_id AS transcriptViewId, status,
      indexed_through AS indexedThrough, target_through AS targetThrough,
      last_error_code AS lastErrorCode
    FROM search_chat_state ORDER BY chat_id
  `).all();
}

export function listStateChatIds(db: Database): string[] {
  return db.query<{ chatId: string }, []>(
    'SELECT chat_id AS chatId FROM search_chat_state ORDER BY chat_id',
  ).all().map((row) => row.chatId);
}

export function statusCounts(db: Database): SearchStatusCounts {
  return db.query<SearchStatusCounts, []>(`
    SELECT
      COALESCE(SUM(status = 'indexed'), 0) AS indexed,
      COALESCE(SUM(status = 'pending'), 0) AS pending,
      COALESCE(SUM(status = 'failed'), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'pending'
        THEN target_through - indexed_through ELSE 0 END), 0) AS backlogRows
    FROM search_chat_state
  `).get()!;
}

export function planChatSync(db: Database, input: {
  readonly mode: 'replace' | 'append';
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly targetThrough: number;
  readonly expectedAfterOrdinal: number;
}): SearchSyncPlan {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (!Number.isSafeInteger(input.targetThrough) || input.targetThrough < 0
      || !Number.isSafeInteger(input.expectedAfterOrdinal) || input.expectedAfterOrdinal < 0) {
    throw searchError('SEARCH_FRONTIER_INVALID');
  }
  const prior = getChatState(db, input.chatId);
  if (prior
      && prior.status === 'indexed'
      && prior.transcriptViewId === input.transcriptViewId
      && prior.indexedThrough >= input.targetThrough) {
    return { plan: 'current', state: prior };
  }
  if (input.mode === 'append') {
    if (!prior || prior.transcriptViewId !== input.transcriptViewId) {
      throw searchError('SEARCH_VIEW_MISMATCH');
    }
    if (prior.status !== 'indexed' || prior.indexedThrough !== input.expectedAfterOrdinal) {
      throw searchError('SEARCH_INDEX_GAP');
    }
  }

  return runTransaction(db, () => {
    const resume = input.mode === 'append'
      || (prior !== null && prior.transcriptViewId === input.transcriptViewId);
    const indexedThrough = resume ? Math.min(prior?.indexedThrough ?? 0, input.targetThrough) : 0;
    db.query(`
      INSERT INTO search_chat_state(
        chat_id, transcript_view_id, status, indexed_through, target_through,
        last_error_code, updated_at
      ) VALUES (?, ?, 'pending', ?, ?, NULL, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        transcript_view_id = excluded.transcript_view_id,
        status = 'pending',
        indexed_through = excluded.indexed_through,
        target_through = excluded.target_through,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.chatId,
      input.transcriptViewId,
      indexedThrough,
      input.targetThrough,
      new Date().toISOString(),
    );
    const state = getChatState(db, input.chatId);
    if (!state) throw searchError('SEARCH_STATE_INVARIANT');
    const staleRows = db.query<{ found: 1 }, [string, string, number]>(`
      SELECT 1 AS found FROM search_chunks
      WHERE chat_id = ? AND (transcript_view_id <> ? OR ordinal > ?) LIMIT 1
    `).get(input.chatId, input.transcriptViewId, indexedThrough) !== null;
    return { plan: 'build', state, staleRows };
  });
}

export function deleteStaleRowsBatch(db: Database, input: {
  readonly chatId: string;
  readonly keepViewId: string;
  readonly keepThrough: number;
  readonly limit?: number;
}): number {
  requireIdentifier(input.chatId);
  requireIdentifier(input.keepViewId);
  const limit = input.limit ?? SEARCH_DELETE_BATCH_MAX_ROWS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_DELETE_BATCH_MAX_ROWS) {
    throw searchError('SEARCH_BATCH_TOO_LARGE');
  }
  return runTransaction(db, () => db.query<{ id: number }, [string, string, number, number]>(`
    DELETE FROM search_chunks WHERE id IN (
      SELECT id FROM search_chunks
      WHERE chat_id = ? AND (transcript_view_id <> ? OR ordinal > ?)
      LIMIT ?
    )
    RETURNING id
  `).all(input.chatId, input.keepViewId, input.keepThrough, limit).length);
}

export function insertRowsBatch(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly rows: readonly HistoricalSearchMessageRow[];
  readonly advanceTo: number;
}): SearchChatState {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (input.rows.length > SEARCH_INGEST_TXN_MAX_ROWS) {
    throw searchError('SEARCH_BATCH_TOO_LARGE');
  }
  let batchBytes = 0;
  for (const row of input.rows) {
    const rowBytes = Buffer.byteLength(row.body, 'utf8');
    if (rowBytes > SEARCH_INGEST_ROW_MAX_BYTES) throw searchError('SEARCH_ROW_TOO_LARGE');
    if (row.timestamp !== null && typeof row.timestamp !== 'string') {
      throw searchError('SEARCH_ROW_INVALID');
    }
    const timestampBytes = row.timestamp === null ? 0 : Buffer.byteLength(row.timestamp, 'utf8');
    if (timestampBytes > SEARCH_TIMESTAMP_MAX_BYTES) throw searchError('SEARCH_ROW_INVALID');
    batchBytes += rowBytes + timestampBytes;
  }
  if (input.rows.length > 1 && batchBytes > SEARCH_INGEST_TXN_MAX_BYTES) {
    throw searchError('SEARCH_BATCH_TOO_LARGE');
  }

  return runTransaction(db, () => {
    const state = getChatState(db, input.chatId);
    if (!state || state.transcriptViewId !== input.transcriptViewId) {
      throw searchError('SEARCH_VIEW_MISMATCH');
    }
    if (state.status !== 'pending'
        || !Number.isSafeInteger(input.advanceTo)
        || input.advanceTo <= state.indexedThrough
        || input.advanceTo > state.targetThrough) {
      throw searchError('SEARCH_FRONTIER_INVALID');
    }
    let previous = state.indexedThrough;
    const insert = db.query(`
      INSERT INTO search_chunks(chat_id, transcript_view_id, ordinal, role, timestamp, body)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of input.rows) {
      if (!Number.isSafeInteger(row.ordinal)
          || row.ordinal <= previous
          || row.ordinal > input.advanceTo
          || !Object.hasOwn(ROLE_CODES, row.role)
          || row.body.length === 0) {
        throw searchError('SEARCH_ROW_INVALID');
      }
      insert.run(
        input.chatId,
        input.transcriptViewId,
        row.ordinal,
        ROLE_CODES[row.role],
        row.timestamp,
        row.body,
      );
      previous = row.ordinal;
    }
    db.query(`
      UPDATE search_chat_state SET indexed_through = ?, updated_at = ?
      WHERE chat_id = ?
    `).run(input.advanceTo, new Date().toISOString(), input.chatId);
    db.exec(`INSERT INTO search_chunks_fts(search_chunks_fts, rank)
      VALUES ('merge', ${SEARCH_FTS_MERGE_PAGES_PER_TXN})`);
    const updated = getChatState(db, input.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return updated;
  });
}

export function finishChatSync(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
}): SearchChatState {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  return runTransaction(db, () => {
    const state = getChatState(db, input.chatId);
    if (!state
        || state.transcriptViewId !== input.transcriptViewId
        || state.status !== 'pending') {
      throw searchError('SEARCH_STATE_INVARIANT');
    }
    if (state.indexedThrough !== state.targetThrough) {
      throw searchError('SEARCH_FRONTIER_INVALID');
    }
    db.query(`
      UPDATE search_chat_state SET status = 'indexed', last_error_code = NULL, updated_at = ?
      WHERE chat_id = ?
    `).run(new Date().toISOString(), input.chatId);
    const updated = getChatState(db, input.chatId);
    if (!updated) throw searchError('SEARCH_STATE_INVARIANT');
    return updated;
  });
}

export function markChatFailed(db: Database, input: {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly errorCode: string;
}): void {
  requireIdentifier(input.chatId);
  requireIdentifier(input.transcriptViewId);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode)) {
    throw searchError('INVALID_SEARCH_ERROR_CODE');
  }
  runTransaction(db, () => {
    const prior = getChatState(db, input.chatId);
    const sameView = prior?.transcriptViewId === input.transcriptViewId;
    db.query(`
      INSERT INTO search_chat_state(
        chat_id, transcript_view_id, status, indexed_through, target_through,
        last_error_code, updated_at
      ) VALUES (?, ?, 'failed', 0, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        transcript_view_id = excluded.transcript_view_id,
        status = 'failed',
        indexed_through = CASE WHEN ? THEN indexed_through ELSE 0 END,
        target_through = CASE WHEN ? THEN target_through ELSE 0 END,
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `).run(
      input.chatId,
      input.transcriptViewId,
      input.errorCode,
      new Date().toISOString(),
      sameView ? 1 : 0,
      sameView ? 1 : 0,
    );
  });
}

export function deleteChatBatch(
  db: Database,
  chatId: string,
  limit = SEARCH_DELETE_BATCH_MAX_ROWS,
): { readonly done: boolean; readonly deletedRows: number } {
  requireIdentifier(chatId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_DELETE_BATCH_MAX_ROWS) {
    throw searchError('SEARCH_BATCH_TOO_LARGE');
  }
  return runTransaction(db, () => {
    const deletedRows = db.query<{ id: number }, [string, number]>(`
      DELETE FROM search_chunks WHERE id IN (
        SELECT id FROM search_chunks WHERE chat_id = ? LIMIT ?
      )
      RETURNING id
    `).all(chatId, limit).length;
    if (deletedRows < limit) {
      db.query('DELETE FROM search_chat_state WHERE chat_id = ?').run(chatId);
      return { done: true, deletedRows };
    }
    return { done: false, deletedRows };
  });
}

export function runIdleMaintenance(db: Database): void {
  db.exec('PRAGMA incremental_vacuum(512)');
  for (let pass = 0; pass < 2; pass += 1) {
    db.exec("INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES ('merge', 64)");
  }
}

export function observeWalTruncate(db: Database): { busy: number; logFrames: number } {
  const row = db.query<{ busy: number; log: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
  return { busy: Number(row?.busy ?? 1), logFrames: Number(row?.log ?? -1) };
}
