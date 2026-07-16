import { Database } from 'bun:sqlite';
import { promises as fs } from 'fs';
import path from 'path';
import type { HistoricalSearchMessageRow, SearchMessageRowInput } from './worker-protocol.js';

export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 3;

export type SearchChatStatus = 'pending' | 'dirty' | 'sealed' | 'failed' | 'unsupported';

export interface SearchDatabase {
  db: Database;
  dbPath: string;
}

export function configureConnection(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const foreignKeys = Number(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys ?? 0);
  const secureDelete = Number(db.query<{ secure_delete: number }, []>('PRAGMA secure_delete').get()?.secure_delete ?? 0);
  if (foreignKeys !== 1 || secureDelete !== 1) {
    throw new Error('SQLite safety pragmas could not be enabled');
  }
}

export function createSchema(db: Database): void {
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS search_chat_state (
      chat_id TEXT PRIMARY KEY,
      source_key TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('pending', 'dirty', 'sealed', 'failed', 'unsupported')),
      last_error_code TEXT,
      indexed_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS search_chunks (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES search_chat_state(chat_id) ON DELETE CASCADE,
      message_ordinal INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool', 'system')),
      timestamp TEXT,
      body TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS search_chunks_chat_ordinal_idx
      ON search_chunks(chat_id, message_ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks_fts USING fts5(
      body,
      content='search_chunks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS search_chunks_ai AFTER INSERT ON search_chunks BEGIN
      INSERT INTO search_chunks_fts(rowid, body) VALUES (new.id, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS search_chunks_ad AFTER DELETE ON search_chunks BEGIN
      INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body)
      VALUES ('delete', old.id, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS search_chunks_au AFTER UPDATE OF body ON search_chunks BEGIN
      INSERT INTO search_chunks_fts(search_chunks_fts, rowid, body)
      VALUES ('delete', old.id, old.body);
      INSERT INTO search_chunks_fts(rowid, body) VALUES (new.id, new.body);
    END;
  `);
  db.exec("INSERT INTO search_chunks_fts(search_chunks_fts, rank) VALUES ('secure-delete', 1)");
  db.exec(`PRAGMA user_version = ${TRANSCRIPT_SEARCH_SCHEMA_VERSION}`);
}

async function unlinkDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((candidate) => fs.rm(candidate, { force: true })),
  );
}

export async function openSearchDatabase(dbPath: string): Promise<SearchDatabase> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  let db = new Database(dbPath);
  try {
    const initialVersion = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);
    if (initialVersion === 0) {
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
    }
    configureConnection(db);
    const version = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);
    if (version !== 0 && version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION) {
      db.close();
      await unlinkDatabaseFiles(dbPath);
      db = new Database(dbPath);
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
      configureConnection(db);
    }
    createSchema(db);
    await fs.chmod(dbPath, 0o600);
    return { db, dbPath };
  } catch (error) {
    try { db.close(); } catch { /* Best-effort close after an open failure. */ }
    throw error;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

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

export function replaceChatRows(
  db: Database,
  chatId: string,
  generation: number,
  sourceKey: string,
  rows: HistoricalSearchMessageRow[],
): boolean {
  const currentGeneration = Number(db.query<{ generation: number }, [string]>(
    'SELECT generation FROM search_chat_state WHERE chat_id = ?',
  ).get(chatId)?.generation ?? 0);
  if (currentGeneration > generation) return false;

  const timestamp = nowIso();
  runTransaction(db, () => {
    db.query(`
      INSERT INTO search_chat_state (
        chat_id, source_key, generation, message_count, status,
        last_error_code, indexed_at, updated_at
      ) VALUES (?, ?, ?, ?, 'sealed', NULL, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        source_key = excluded.source_key,
        generation = excluded.generation,
        message_count = excluded.message_count,
        status = 'sealed',
        last_error_code = NULL,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at
      WHERE search_chat_state.generation <= excluded.generation
    `).run(chatId, sourceKey, generation, rows.length, timestamp, timestamp);
    const acceptedGeneration = Number(db.query<{ generation: number }, [string]>(
      'SELECT generation FROM search_chat_state WHERE chat_id = ?',
    ).get(chatId)?.generation ?? -1);
    if (acceptedGeneration !== generation) return;
    db.query('DELETE FROM search_chunks WHERE chat_id = ?').run(chatId);
    const insert = db.query(`
      INSERT INTO search_chunks (chat_id, message_ordinal, role, timestamp, body)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      insert.run(chatId, row.messageOrdinal, row.role, row.timestamp, row.body);
    }
  });
  return true;
}

export function appendChatRows(
  db: Database,
  chatId: string,
  generation: number,
  rows: SearchMessageRowInput[],
): void {
  if (rows.length === 0) return;
  const timestamp = nowIso();
  runTransaction(db, () => {
    db.query(`
      INSERT INTO search_chat_state (
        chat_id, source_key, generation, message_count, status,
        last_error_code, indexed_at, updated_at
      ) VALUES (?, NULL, ?, 0, 'dirty', NULL, NULL, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        generation = MAX(search_chat_state.generation, excluded.generation),
        status = 'dirty',
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run(chatId, generation, timestamp);
    const currentMax = Number(db.query<{ value: number | null }, [string]>(`
      SELECT MAX(message_ordinal) AS value
      FROM search_chunks INDEXED BY search_chunks_chat_ordinal_idx
      WHERE chat_id = ?
    `).get(chatId)?.value ?? 0);
    const insert = db.query(`
      INSERT INTO search_chunks (chat_id, message_ordinal, role, timestamp, body)
      VALUES (?, ?, ?, ?, ?)
    `);
    rows.forEach((row, index) => {
      insert.run(chatId, currentMax + index + 1, row.role, row.timestamp, row.body);
    });
    db.query(`
      UPDATE search_chat_state
      SET message_count = (SELECT COUNT(*) FROM search_chunks WHERE chat_id = ?),
          updated_at = ?
      WHERE chat_id = ?
    `).run(chatId, timestamp, chatId);
  });
}

export function markChatStatus(
  db: Database,
  chatId: string,
  generation: number,
  status: Extract<SearchChatStatus, 'dirty' | 'failed' | 'unsupported' | 'pending'>,
  errorCode: string | null = null,
): void {
  const timestamp = nowIso();
  db.query(`
    INSERT INTO search_chat_state (
      chat_id, source_key, generation, message_count, status,
      last_error_code, indexed_at, updated_at
    ) VALUES (?, NULL, ?, 0, ?, ?, NULL, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      generation = MAX(search_chat_state.generation, excluded.generation),
      status = excluded.status,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at
  `).run(chatId, generation, status, errorCode, timestamp);
}

export function deleteChatRows(db: Database, chatId: string): Database {
  const dbPath = db.filename;
  runTransaction(db, () => {
    db.query('DELETE FROM search_chat_state WHERE chat_id = ?').run(chatId);
  });
  db.close();
  const reopened = new Database(dbPath);
  configureConnection(reopened);
  reopened.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return reopened;
}

export function runIdleMaintenance(db: Database): void {
  db.exec('PRAGMA incremental_vacuum(2048)');
}
