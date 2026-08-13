import { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoricalSearchMessageRow } from './rows.js';

export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 7;

export type SearchChatStatus = 'indexed' | 'failed' | 'unsupported';

export interface SearchDatabase {
  readonly db: Database;
  readonly dbPath: string;
  readonly recreated: boolean;
}

export interface SearchChatState {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly indexedThrough: number;
  readonly status: SearchChatStatus;
}

const ROLE_CODES = { user: 0, assistant: 1, tool: 2, system: 3 } as const;

function runTransaction(db: Database, work: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
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
  db.exec(`
    CREATE TABLE search_chat_state (
      chat_id            TEXT PRIMARY KEY,
      transcript_view_id TEXT NOT NULL,
      indexed_through    INTEGER NOT NULL,
      status             TEXT NOT NULL CHECK(status IN ('indexed', 'failed', 'unsupported')),
      last_error_code    TEXT,
      updated_at         TEXT NOT NULL
    ) WITHOUT ROWID, STRICT;

    CREATE TABLE search_chunks (
      id                 INTEGER PRIMARY KEY,
      chat_id            TEXT NOT NULL REFERENCES search_chat_state(chat_id) ON DELETE CASCADE,
      transcript_view_id TEXT NOT NULL,
      ordinal            INTEGER NOT NULL,
      role               INTEGER NOT NULL CHECK(role IN (0, 1, 2, 3)),
      timestamp          TEXT,
      body               TEXT NOT NULL,
      chat_scope         TEXT NOT NULL GENERATED ALWAYS AS (
        'c' || lower(hex(CAST(chat_id AS BLOB)))
      ) STORED,
      UNIQUE(chat_id, transcript_view_id, ordinal)
    ) STRICT;

    CREATE VIRTUAL TABLE search_chunks_fts USING fts5(
      body,
      chat_scope,
      content='search_chunks',
      content_rowid='id',
      columnsize=0,
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER search_chunks_ai AFTER INSERT ON search_chunks BEGIN
      INSERT INTO search_chunks_fts(rowid, body, chat_scope)
      VALUES (new.id, new.body, new.chat_scope);
    END;

    CREATE TRIGGER search_chunks_ad AFTER DELETE ON search_chunks BEGIN
      INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body, chat_scope)
      VALUES ('delete', old.id, old.body, old.chat_scope);
    END;

    CREATE TRIGGER search_chunks_au AFTER UPDATE OF body, chat_id ON search_chunks BEGIN
      INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body, chat_scope)
      VALUES ('delete', old.id, old.body, old.chat_scope);
      INSERT INTO search_chunks_fts(rowid, body, chat_scope)
      VALUES (new.id, new.body, new.chat_scope);
    END;
  `);
  db.exec("INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES ('secure-delete', 1)");
  db.exec("INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES ('rank', 'bm25(1.0, 0.0)')");
  db.exec(`PRAGMA user_version = ${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`);
}

function validateExistingSchema(db: Database): void {
  const version = Number(
    db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0,
  );
  if (version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION) {
    throw new Error('Transcript search schema version is invalid');
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
    validateExistingSchema(db);
    db.exec('PRAGMA query_only = ON');
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
    SELECT chat_id AS chatId, transcript_view_id AS transcriptViewId,
      indexed_through AS indexedThrough, status
    FROM search_chat_state WHERE chat_id = ?
  `).get(chatId) ?? null;
}

function insertRows(
  db: Database,
  chatId: string,
  transcriptViewId: string,
  rows: readonly HistoricalSearchMessageRow[],
): void {
  const insert = db.query(`
    INSERT INTO search_chunks(
      chat_id, transcript_view_id, ordinal, role, timestamp, body
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      chatId,
      transcriptViewId,
      row.ordinal,
      ROLE_CODES[row.role],
      row.timestamp,
      row.body,
    );
  }
}

export function replaceChatRows(
  db: Database,
  input: {
    readonly chatId: string;
    readonly transcriptViewId: string;
    readonly throughOrdinal: number;
    readonly rows: readonly HistoricalSearchMessageRow[];
  },
): void {
  const timestamp = new Date().toISOString();
  runTransaction(db, () => {
    db.query(`
      INSERT INTO search_chat_state(
        chat_id, transcript_view_id, indexed_through, status, last_error_code, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        transcript_view_id = excluded.transcript_view_id,
        indexed_through = excluded.indexed_through,
        status = excluded.status,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.chatId,
      input.transcriptViewId,
      input.throughOrdinal,
      input.rows.length > 0 ? 'indexed' : 'unsupported',
      timestamp,
    );
    db.query('DELETE FROM search_chunks WHERE chat_id = ?').run(input.chatId);
    insertRows(db, input.chatId, input.transcriptViewId, input.rows);
  });
}

export function appendChatRows(
  db: Database,
  input: {
    readonly chatId: string;
    readonly transcriptViewId: string;
    readonly expectedAfterOrdinal: number;
    readonly throughOrdinal: number;
    readonly rows: readonly HistoricalSearchMessageRow[];
  },
): void {
  const state = getChatState(db, input.chatId);
  if (!state || state.transcriptViewId !== input.transcriptViewId) {
    throw new Error('SEARCH_VIEW_MISMATCH');
  }
  if (state.indexedThrough >= input.throughOrdinal) return;
  if (state.indexedThrough !== input.expectedAfterOrdinal) throw new Error('SEARCH_INDEX_GAP');
  const timestamp = new Date().toISOString();
  runTransaction(db, () => {
    insertRows(db, input.chatId, input.transcriptViewId, input.rows);
    const searchable = Number(db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM search_chunks WHERE chat_id = ?
    `).get(input.chatId)?.count ?? 0);
    db.query(`
      UPDATE search_chat_state SET indexed_through = ?, status = ?,
        last_error_code = NULL, updated_at = ?
      WHERE chat_id = ? AND transcript_view_id = ?
    `).run(
      input.throughOrdinal,
      searchable > 0 ? 'indexed' : 'unsupported',
      timestamp,
      input.chatId,
      input.transcriptViewId,
    );
  });
}

export function markChatFailed(
  db: Database,
  chatId: string,
  transcriptViewId: string,
  errorCode: string,
): void {
  db.query(`
    INSERT INTO search_chat_state(
      chat_id, transcript_view_id, indexed_through, status, last_error_code, updated_at
    ) VALUES (?, ?, 0, 'failed', ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET status = 'failed',
      last_error_code = excluded.last_error_code, updated_at = excluded.updated_at
  `).run(chatId, transcriptViewId, errorCode, new Date().toISOString());
}

export function deleteChatRows(db: Database, chatId: string): void {
  db.query('DELETE FROM search_chat_state WHERE chat_id = ?').run(chatId);
}

export function pruneMissingChats(db: Database, chatIds: readonly string[]): void {
  db.query(`
    DELETE FROM search_chat_state
    WHERE chat_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  `).run(JSON.stringify([...new Set(chatIds)]));
}

export function runIdleMaintenance(db: Database): void {
  db.exec('PRAGMA incremental_vacuum(2048)');
}
