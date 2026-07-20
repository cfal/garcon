import { Database } from 'bun:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoricalSearchMessageRow } from './rows.js';

export const TRANSCRIPT_SEARCH_SCHEMA_VERSION = 4;

export type SearchChatStatus = 'pending' | 'sealed' | 'failed' | 'unsupported';

export interface SearchDatabase {
  readonly db: Database;
  readonly dbPath: string;
  readonly recreated: boolean;
}

export interface SearchChatState {
  readonly chatId: string;
  readonly agentId: string;
  readonly model: string;
  readonly sourceDescriptorHash: string | null;
  readonly sourceRevision: string | null;
  readonly carryOverRevision: string;
  readonly contentDigest: string | null;
  readonly sealedSourceKey: string | null;
  readonly operationEpoch: string;
  readonly operationSequence: number;
  readonly messageCount: number;
  readonly status: SearchChatStatus;
  readonly lastCheckedAt: string | null;
}

export interface SearchChatAttempt {
  readonly chatId: string;
  readonly agentId: string;
  readonly model: string;
  readonly sourceApiVersion: number;
  readonly projectorVersion: number;
  readonly sourceDescriptorHash: string | null;
  readonly sourceRevision: string | null;
  readonly carryOverRevision: string;
  readonly operationEpoch: string;
  readonly operationSequence: number;
}

export interface SearchChatSeal extends SearchChatAttempt {
  readonly contentDigest: string;
  readonly sealedSourceKey: string;
  readonly messageCount: number;
}

const ROLE_CODES = { user: 0, assistant: 1, tool: 2, system: 3 } as const;

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
    CREATE TABLE search_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE search_chat_state (
      chat_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      model TEXT NOT NULL,
      source_api_version INTEGER NOT NULL,
      projector_version INTEGER NOT NULL,
      source_descriptor_hash TEXT,
      source_revision TEXT,
      carry_over_revision TEXT NOT NULL,
      content_digest TEXT,
      sealed_source_key TEXT,
      operation_epoch TEXT NOT NULL,
      operation_sequence INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sealed', 'failed', 'unsupported')),
      last_error_code TEXT,
      last_checked_at TEXT,
      indexed_at TEXT,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID, STRICT;
    CREATE TABLE search_chunks (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES search_chat_state(chat_id) ON DELETE CASCADE,
      message_ordinal INTEGER NOT NULL,
      role INTEGER NOT NULL CHECK(role IN (0, 1, 2, 3)),
      timestamp TEXT,
      body TEXT NOT NULL,
      source_anchor TEXT,
      chat_scope TEXT NOT NULL GENERATED ALWAYS AS (
        'c' || lower(hex(CAST(chat_id AS BLOB)))
      ) STORED,
      UNIQUE(chat_id, message_ordinal)
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
  const version = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);
  const autoVacuum = Number(db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum ?? 0);
  if (version !== TRANSCRIPT_SEARCH_SCHEMA_VERSION || autoVacuum !== 2) {
    throw new Error('Transcript search schema version or auto-vacuum mode is invalid');
  }
  const required = new Set([
    'search_meta', 'search_chat_state', 'search_chunks', 'search_chunks_fts',
    'search_chunks_ai', 'search_chunks_ad', 'search_chunks_au',
  ]);
  const rows = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master WHERE name IN (
      'search_meta', 'search_chat_state', 'search_chunks', 'search_chunks_fts',
      'search_chunks_ai', 'search_chunks_ad', 'search_chunks_au'
    )
  `).all();
  for (const row of rows) required.delete(row.name);
  if (required.size > 0) throw new Error('Transcript search schema is incomplete');
  const chunksSql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE name = 'search_chunks'",
  ).get()?.sql ?? '';
  if (!/source_anchor/i.test(chunksSql) || !/chat_scope/i.test(chunksSql)) {
    throw new Error('Transcript search chunk schema is invalid');
  }
  requireColumns(db, 'search_chat_state', [
    'chat_id', 'agent_id', 'model', 'source_api_version', 'projector_version',
    'source_descriptor_hash', 'source_revision', 'carry_over_revision',
    'content_digest', 'sealed_source_key', 'operation_epoch', 'operation_sequence',
    'message_count', 'status', 'last_error_code', 'last_checked_at', 'indexed_at',
    'updated_at',
  ]);
  requireColumns(db, 'search_chunks', [
    'id', 'chat_id', 'message_ordinal', 'role', 'timestamp', 'body',
    'source_anchor', 'chat_scope',
  ]);
  const ftsSql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE name = 'search_chunks_fts'",
  ).get()?.sql ?? '';
  if (!/fts5/i.test(ftsSql) || !/columnsize\s*=\s*0/i.test(ftsSql)
      || !/content\s*=\s*'search_chunks'/i.test(ftsSql)) {
    throw new Error('Transcript search FTS schema is invalid');
  }
  const foreignKey = db.query<{ table: string; from: string; to: string; on_delete: string }, []>(
    'PRAGMA foreign_key_list(search_chunks)',
  ).all().some((entry) => entry.table === 'search_chat_state'
    && entry.from === 'chat_id' && entry.to === 'chat_id' && entry.on_delete === 'CASCADE');
  if (!foreignKey) throw new Error('Transcript search foreign key schema is invalid');
}

function requireColumns(db: Database, table: string, expected: readonly string[]): void {
  const actual = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .map((column) => column.name));
  if (expected.some((column) => !actual.has(column))) {
    throw new Error(`Transcript search ${table} schema is incomplete`);
  }
}

async function unlinkDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((file) => fs.rm(file, { force: true })));
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

function markCleanShutdown(db: Database, clean: boolean): void {
  db.query(`
    INSERT INTO search_meta(key, value) VALUES ('clean_shutdown', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(clean ? '1' : '0');
}

async function createFreshDatabase(dbPath: string): Promise<SearchDatabase> {
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    configureConnection(db);
    createSchema(db);
    markCleanShutdown(db, false);
    await protectDatabaseFiles(dbPath);
    return { db, dbPath, recreated: true };
  } catch (error) {
    db.close();
    throw error;
  }
}

export async function openSearchDatabase(dbPath: string): Promise<SearchDatabase> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const exists = await fs.stat(dbPath).then((entry) => entry.isFile() && entry.size > 0).catch(() => false);
  if (!exists) return createFreshDatabase(dbPath);
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    configureConnection(db);
    validateExistingSchema(db);
    markCleanShutdown(db, false);
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
    const queryOnly = Number(db.query<{ query_only: number }, []>('PRAGMA query_only').get()?.query_only ?? 0);
    if (queryOnly !== 1) throw new Error('Transcript search reader is not query-only');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeSearchDatabase(db: Database): void {
  try {
    markCleanShutdown(db, true);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

export function prepareChatBuild(db: Database): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS temp_search_build (
      message_ordinal INTEGER PRIMARY KEY,
      role INTEGER NOT NULL,
      timestamp TEXT,
      body TEXT NOT NULL,
      source_anchor TEXT
    ) WITHOUT ROWID
  `);
  db.query('DELETE FROM temp_search_build').run();
}

export function stageChatRows(db: Database, rows: readonly HistoricalSearchMessageRow[]): void {
  const insert = db.query(`
    INSERT INTO temp_search_build(message_ordinal, role, timestamp, body, source_anchor)
    VALUES (?, ?, ?, ?, ?)
  `);
  runTransaction(db, () => {
    for (const row of rows) {
      insert.run(row.messageOrdinal, ROLE_CODES[row.role], row.timestamp, row.body, row.sourceAnchor ?? null);
    }
  });
}

export function getChatState(db: Database, chatId: string): SearchChatState | null {
  return db.query<SearchChatState, [string]>(`
    SELECT chat_id AS chatId, agent_id AS agentId, model,
      source_descriptor_hash AS sourceDescriptorHash, source_revision AS sourceRevision,
      carry_over_revision AS carryOverRevision, content_digest AS contentDigest,
      sealed_source_key AS sealedSourceKey, operation_epoch AS operationEpoch,
      operation_sequence AS operationSequence, message_count AS messageCount, status,
      last_checked_at AS lastCheckedAt
    FROM search_chat_state WHERE chat_id = ?
  `).get(chatId) ?? null;
}

export function getChatSafetyStates(
  db: Database,
): Map<string, { readonly sourceRevision: string | null; readonly lastCheckedAt: string | null }> {
  const rows = db.query<{
    chatId: string;
    sourceRevision: string | null;
    lastCheckedAt: string | null;
  }, []>(`
    SELECT chat_id AS chatId, source_revision AS sourceRevision,
      last_checked_at AS lastCheckedAt
    FROM search_chat_state
  `).all();
  return new Map(rows.map((row) => [row.chatId, row]));
}

export function markChatAttempt(
  db: Database,
  attempt: SearchChatAttempt,
  status: Exclude<SearchChatStatus, 'sealed'>,
  errorCode: string | null = null,
): void {
  const timestamp = nowIso();
  db.query(`
    INSERT INTO search_chat_state(
      chat_id, agent_id, model, source_api_version, projector_version,
      source_descriptor_hash, source_revision, carry_over_revision,
      operation_epoch, operation_sequence, message_count, status,
      last_error_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      model = excluded.model,
      source_api_version = excluded.source_api_version,
      projector_version = excluded.projector_version,
      operation_epoch = excluded.operation_epoch,
      operation_sequence = excluded.operation_sequence,
      status = excluded.status,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at
  `).run(
    attempt.chatId, attempt.agentId, attempt.model, attempt.sourceApiVersion,
    attempt.projectorVersion, attempt.sourceDescriptorHash, attempt.sourceRevision,
    attempt.carryOverRevision, attempt.operationEpoch, attempt.operationSequence,
    status, errorCode, timestamp,
  );
}

export function sealChatFromStaging(db: Database, seal: SearchChatSeal): void {
  const timestamp = nowIso();
  runTransaction(db, () => {
    db.query(`
      INSERT INTO search_chat_state(
        chat_id, agent_id, model, source_api_version, projector_version,
        source_descriptor_hash, source_revision, carry_over_revision,
        content_digest, sealed_source_key, operation_epoch, operation_sequence,
        message_count, status, last_error_code, last_checked_at, indexed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sealed', NULL, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        agent_id = excluded.agent_id,
        model = excluded.model,
        source_api_version = excluded.source_api_version,
        projector_version = excluded.projector_version,
        source_descriptor_hash = excluded.source_descriptor_hash,
        source_revision = excluded.source_revision,
        carry_over_revision = excluded.carry_over_revision,
        content_digest = excluded.content_digest,
        sealed_source_key = excluded.sealed_source_key,
        operation_epoch = excluded.operation_epoch,
        operation_sequence = excluded.operation_sequence,
        message_count = excluded.message_count,
        status = 'sealed', last_error_code = NULL,
        last_checked_at = excluded.last_checked_at,
        indexed_at = excluded.indexed_at, updated_at = excluded.updated_at
    `).run(
      seal.chatId, seal.agentId, seal.model, seal.sourceApiVersion, seal.projectorVersion,
      seal.sourceDescriptorHash, seal.sourceRevision, seal.carryOverRevision,
      seal.contentDigest, seal.sealedSourceKey, seal.operationEpoch, seal.operationSequence,
      seal.messageCount, timestamp, timestamp, timestamp,
    );
    db.query('DELETE FROM search_chunks WHERE chat_id = ?').run(seal.chatId);
    db.query(`
      INSERT INTO search_chunks(chat_id, message_ordinal, role, timestamp, body, source_anchor)
      SELECT ?, message_ordinal, role, timestamp, body, source_anchor
      FROM temp_search_build ORDER BY message_ordinal
    `).run(seal.chatId);
  });
}

export function deleteChatRows(db: Database, chatId: string): void {
  db.query('DELETE FROM search_chat_state WHERE chat_id = ?').run(chatId);
}

export function pruneMissingChats(db: Database, chatIds: readonly string[]): void {
  const json = JSON.stringify([...new Set(chatIds)]);
  db.query(`
    DELETE FROM search_chat_state
    WHERE chat_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  `).run(json);
}

export function runIdleMaintenance(db: Database): void {
  db.exec('PRAGMA incremental_vacuum(2048)');
}

// Retains the benchmark helper while the production writer uses explicit v4 seals.
export function replaceChatRows(
  db: Database,
  chatId: string,
  generation: number,
  sourceKey: string,
  rows: HistoricalSearchMessageRow[],
): boolean {
  prepareChatBuild(db);
  stageChatRows(db, rows);
  sealChatFromStaging(db, {
    chatId,
    agentId: 'benchmark',
    model: '',
    sourceApiVersion: 1,
    projectorVersion: 1,
    sourceDescriptorHash: null,
    sourceRevision: sourceKey,
    carryOverRevision: 'carry-v1:0',
    contentDigest: sourceKey,
    sealedSourceKey: sourceKey,
    operationEpoch: 'benchmark',
    operationSequence: generation,
    messageCount: rows.length,
  });
  return true;
}
