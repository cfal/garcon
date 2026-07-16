import { Database } from 'bun:sqlite';
import { promises as fs } from 'fs';
import path from 'path';
import type { HistoricalSearchMessageRow, SearchMessageRowInput } from './worker-protocol.js';

export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 3;

export type SearchChatStatus = 'pending' | 'dirty' | 'sealed' | 'failed' | 'unsupported';

export interface SearchDatabase {
  db: Database;
  dbPath: string;
  recreated: boolean;
}

const ROLE_CODES = {
  user: 0,
  assistant: 1,
  tool: 2,
  system: 3,
} as const;

function roleCode(role: SearchMessageRowInput['role']): number {
  return ROLE_CODES[role];
}

export function configureConnection(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA secure_delete = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const foreignKeys = Number(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys ?? 0);
  const secureDelete = Number(db.query<{ secure_delete: number }, []>('PRAGMA secure_delete').get()?.secure_delete ?? 0);
  const journalMode = String(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode ?? '');
  const synchronous = Number(db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous ?? -1);
  if (foreignKeys !== 1 || secureDelete !== 1 || journalMode.toLowerCase() !== 'wal' || synchronous !== 1) {
    throw new Error('SQLite safety pragmas could not be enabled');
  }
}

export function openSearchReadDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 2000');
    validateExistingSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
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
      role INTEGER NOT NULL CHECK(role IN (0, 1, 2, 3)),
      timestamp TEXT,
      body TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS search_chunks_chat_ordinal_idx
      ON search_chunks(chat_id, message_ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks_fts USING fts5(
      body,
      content='search_chunks',
      content_rowid='id',
      columnsize=0,
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

function markCleanShutdown(db: Database, clean: boolean): void {
  db.query(`
    INSERT INTO search_meta (key, value) VALUES ('clean_shutdown', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(clean ? '1' : '0');
}

function validateExistingSchema(db: Database): void {
  const version = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);
  const autoVacuum = Number(db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
  if (version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION || autoVacuum !== 2) {
    throw new Error('Transcript search schema version or auto-vacuum mode is invalid');
  }
  const required = new Set([
    'search_meta',
    'search_chat_state',
    'search_chunks',
    'search_chunks_chat_ordinal_idx',
    'search_chunks_fts',
    'search_chunks_ai',
    'search_chunks_ad',
    'search_chunks_au',
  ]);
  const rows = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master
    WHERE name IN (
      'search_meta', 'search_chat_state', 'search_chunks',
      'search_chunks_chat_ordinal_idx', 'search_chunks_fts',
      'search_chunks_ai', 'search_chunks_ad', 'search_chunks_au'
    )
  `).all();
  for (const row of rows) required.delete(row.name);
  if (required.size > 0) throw new Error(`Transcript search schema is incomplete: ${[...required].join(', ')}`);
  const ftsSql = db.query<{ sql: string | null }, []>(`
    SELECT sql FROM sqlite_master WHERE name = 'search_chunks_fts'
  `).get()?.sql ?? '';
  if (!/columnsize\s*=\s*0/i.test(ftsSql)) {
    throw new Error('Transcript search FTS storage options are outdated');
  }
  const chunksSql = db.query<{ sql: string | null }, []>(`
    SELECT sql FROM sqlite_master WHERE name = 'search_chunks'
  `).get()?.sql ?? '';
  if (!/role\s+INTEGER/i.test(chunksSql)) {
    throw new Error('Transcript search role storage is outdated');
  }
}

function validateUncleanDatabase(db: Database): void {
  const quickCheck = String(db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check ?? '');
  if (quickCheck !== 'ok') throw new Error(`Transcript search quick_check failed: ${quickCheck}`);
  db.exec("INSERT INTO search_chunks_fts(search_chunks_fts) VALUES ('integrity-check')");
}

async function createFreshDatabase(dbPath: string): Promise<SearchDatabase> {
  let db = new Database(dbPath);
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    configureConnection(db);
    createSchema(db);
    markCleanShutdown(db, false);
    await fs.chmod(dbPath, 0o600);
    return { db, dbPath, recreated: true };
  } catch (error) {
    try { db.close(); } catch { /* Best-effort close after a creation failure. */ }
    throw error;
  }
}

export async function openSearchDatabase(dbPath: string): Promise<SearchDatabase> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const existed = await fs.stat(dbPath).then((entry) => entry.isFile() && entry.size > 0).catch(() => false);
  if (!existed) return createFreshDatabase(dbPath);

  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    configureConnection(db);
    validateExistingSchema(db);
    const clean = db.query<{ value: string }, []>(
      "SELECT value FROM search_meta WHERE key = 'clean_shutdown'",
    ).get()?.value === '1';
    if (!clean) validateUncleanDatabase(db);
    markCleanShutdown(db, false);
    await fs.chmod(dbPath, 0o600);
    return { db, dbPath, recreated: false };
  } catch {
    try { db?.close(); } catch { /* Best-effort close before derived-index recreation. */ }
    await unlinkDatabaseFiles(dbPath);
    return createFreshDatabase(dbPath);
  }
}

export function closeSearchDatabase(db: Database): void {
  try {
    markCleanShutdown(db, true);
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      try { markCleanShutdown(db, false); } catch { /* The original checkpoint failure remains primary. */ }
      throw error;
    }
  } finally {
    db.close();
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
  prepareChatBuild(db);
  stageChatRows(db, rows);
  return replaceChatFromStaging(db, chatId, generation, sourceKey, rows.length);
}

export function prepareChatBuild(db: Database): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS temp_search_build (
      message_ordinal INTEGER PRIMARY KEY,
      role INTEGER NOT NULL,
      timestamp TEXT,
      body TEXT NOT NULL
    ) WITHOUT ROWID
  `);
  db.query('DELETE FROM temp_search_build').run();
}

export function stageChatRows(db: Database, rows: HistoricalSearchMessageRow[]): void {
  const insert = db.query(`
    INSERT INTO temp_search_build (message_ordinal, role, timestamp, body)
    VALUES (?, ?, ?, ?)
  `);
  runTransaction(db, () => {
    for (const row of rows) insert.run(row.messageOrdinal, roleCode(row.role), row.timestamp, row.body);
  });
}

export function replaceChatFromStaging(
  db: Database,
  chatId: string,
  generation: number,
  sourceKey: string,
  messageCount: number,
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
    `).run(chatId, sourceKey, generation, messageCount, timestamp, timestamp);
    const acceptedGeneration = Number(db.query<{ generation: number }, [string]>(
      'SELECT generation FROM search_chat_state WHERE chat_id = ?',
    ).get(chatId)?.generation ?? -1);
    if (acceptedGeneration !== generation) return;
    db.query('DELETE FROM search_chunks WHERE chat_id = ?').run(chatId);
    db.query(`
      INSERT INTO search_chunks (chat_id, message_ordinal, role, timestamp, body)
      SELECT ?, message_ordinal, role, timestamp, body
      FROM temp_search_build
      ORDER BY message_ordinal
    `).run(chatId);
  });
  return true;
}

export function appendChatRows(
  db: Database,
  chatId: string,
  generation: number,
  rows: SearchMessageRowInput[],
): boolean {
  if (rows.length === 0) return false;
  const persistedGeneration = Number(db.query<{ generation: number }, [string]>(
    'SELECT generation FROM search_chat_state WHERE chat_id = ?',
  ).get(chatId)?.generation ?? 0);
  if (persistedGeneration > generation) return false;
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
      insert.run(chatId, currentMax + index + 1, roleCode(row.role), row.timestamp, row.body);
    });
    db.query(`
      UPDATE search_chat_state
      SET message_count = message_count + ?, updated_at = ?
      WHERE chat_id = ?
    `).run(rows.length, timestamp, chatId);
  });
  return true;
}

export function markChatStatus(
  db: Database,
  chatId: string,
  generation: number,
  status: Extract<SearchChatStatus, 'dirty' | 'failed' | 'unsupported' | 'pending'>,
  errorCode: string | null = null,
): boolean {
  const persistedGeneration = Number(db.query<{ generation: number }, [string]>(
    'SELECT generation FROM search_chat_state WHERE chat_id = ?',
  ).get(chatId)?.generation ?? 0);
  if (persistedGeneration > generation) return false;
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
  return true;
}

export function deleteChatRows(
  db: Database,
  chatId: string,
  generation = Number.MAX_SAFE_INTEGER,
): Database {
  const persistedGeneration = Number(db.query<{ generation: number }, [string]>(
    'SELECT generation FROM search_chat_state WHERE chat_id = ?',
  ).get(chatId)?.generation ?? 0);
  if (persistedGeneration > generation) return db;
  runTransaction(db, () => {
    db.query('DELETE FROM search_chat_state WHERE chat_id = ?').run(chatId);
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return db;
}

export function pruneMissingChats(
  db: Database,
  registeredChatIds: string[],
): { db: Database; prunedChatIds: string[] } {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS temp_registered_chats (chat_id TEXT PRIMARY KEY) WITHOUT ROWID');
  db.query('DELETE FROM temp_registered_chats').run();
  const insert = db.query('INSERT OR IGNORE INTO temp_registered_chats (chat_id) VALUES (?)');
  for (const chatId of registeredChatIds) insert.run(chatId);
  const missing = db.query<{ chatId: string }, []>(`
    SELECT state.chat_id AS chatId
    FROM search_chat_state state
    LEFT JOIN temp_registered_chats registered ON registered.chat_id = state.chat_id
    WHERE registered.chat_id IS NULL
  `).all().map((row) => row.chatId);
  if (missing.length === 0) return { db, prunedChatIds: missing };
  runTransaction(db, () => {
    db.exec(`
      DELETE FROM search_chat_state
      WHERE chat_id NOT IN (SELECT chat_id FROM temp_registered_chats)
    `);
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { db, prunedChatIds: missing };
}

export function loadPersistedGenerations(db: Database): Map<string, number> {
  return new Map(db.query<{ chatId: string; generation: number }, []>(`
    SELECT chat_id AS chatId, generation FROM search_chat_state
  `).all().map((row) => [row.chatId, Number(row.generation)]));
}


export function runIdleMaintenance(db: Database): void {
  db.exec('PRAGMA incremental_vacuum(2048)');
}
