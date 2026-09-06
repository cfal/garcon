import { Database } from 'bun:sqlite';
import { chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import { ensureLedgerChatDirectory } from './directories.js';
import { LedgerSchemaError } from './errors.js';
import type { ConnectionCloseAttempt, ConnectionEntry, ViewRecord } from './connection-entry.js';
import type { LedgerRow } from './contracts.js';
import { transcriptViewId, type TranscriptView, type TranscriptViewId } from './contracts.js';
import { lstatIfExists, statSizeIfExists } from './file-stat.js';
import { asError, nextOrdinal, runQuery, runTransaction } from './sqlite-operations.js';

const LEDGER_SCHEMA_VERSION = 1;

export function openConnection(
  rootDirectory: string,
  chatId: string,
  synchronous: 'NORMAL' | 'FULL',
): ConnectionEntry {
  const directory = ensureLedgerChatDirectory(rootDirectory, chatId);
  const databasePath = path.join(directory, 'ledger.sqlite');
  const existed = (statSizeIfExists(databasePath) ?? 0) > 0;
  const db = new Database(databasePath);
  try {
    configureConnection(db, synchronous);
    if (!existed) createSchema(db);
    else validateSchema(db);
    const current = loadAndCleanViews(db);
    chmodSync(databasePath, 0o600);
    return {
      chatId,
      directory,
      db,
      current,
      nextOrdinal: current ? nextOrdinal(db, current.viewId) : 1,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function configureConnection(db: Database, synchronous: 'NORMAL' | 'FULL'): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA synchronous = ${synchronous}`);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

export function createSchema(db: Database): void {
  runTransaction(db, () => {
    db.exec(`
      CREATE TABLE transcript_views (
        view_id               TEXT PRIMARY KEY,
        status                TEXT NOT NULL CHECK (status IN ('current', 'staging')),
        created_at            TEXT NOT NULL,
        content_start_ordinal INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX transcript_one_current
        ON transcript_views(status)
        WHERE status = 'current';

      CREATE TABLE transcript_rows (
        view_id           TEXT NOT NULL
                          REFERENCES transcript_views(view_id) ON DELETE CASCADE,
        ordinal           INTEGER NOT NULL,
        kind              TEXT NOT NULL,
        at                TEXT NOT NULL,
        client_message_id TEXT,
        payload_json      TEXT NOT NULL,
        PRIMARY KEY (view_id, ordinal)
      ) WITHOUT ROWID, STRICT;

      CREATE UNIQUE INDEX transcript_submission
        ON transcript_rows(view_id, client_message_id)
        WHERE client_message_id IS NOT NULL;
    `);
    db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
  });
}

export function validateSchema(db: Database): void {
  const version = Number(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);
  if (version !== LEDGER_SCHEMA_VERSION) {
    throw new LedgerSchemaError(`Unsupported transcript ledger schema version ${version}`);
  }
  const required = new Set(['transcript_views', 'transcript_rows']);
  const records = db.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('transcript_views', 'transcript_rows')
  `).all();
  for (const record of records) required.delete(record.name);
  if (required.size > 0) throw new LedgerSchemaError('Transcript ledger schema is incomplete');
}

export function loadAndCleanViews(db: Database): TranscriptView | null {
  const views = loadViews(db);
  const current = validatedCurrentView(views);
  if (views.some((view) => view.status === 'staging')) {
    db.query("DELETE FROM transcript_views WHERE status = 'staging'").run();
  }
  return current;
}

export function loadViews(db: Database): readonly ViewRecord[] {
  return runQuery(() => (
    db.query<ViewRecord, []>(`
      SELECT view_id, status, created_at, content_start_ordinal
      FROM transcript_views
    `).all()
  ));
}

export function validatedCurrentView(views: readonly ViewRecord[]): TranscriptView | null {
  const current = views.filter((view) => view.status === 'current');
  if (current.length !== 1 && views.length > 0) {
    throw new LedgerSchemaError('Established transcript ledger must have exactly one current view');
  }
  return current[0] ? toView(current[0]) : null;
}

export function rehydrateConnection(entry: ConnectionEntry): void {
  const current = validatedCurrentView(loadViews(entry.db));
  const ordinal = current ? nextOrdinal(entry.db, current.viewId) : 1;
  entry.current = current;
  entry.nextOrdinal = ordinal;
}

export function viewRecord(
  db: Database,
  viewId: TranscriptViewId,
  status: 'current' | 'staging',
): ViewRecord | null {
  return runQuery(() => (
    db.query<ViewRecord, [string, string]>(`
      SELECT view_id, status, created_at, content_start_ordinal
      FROM transcript_views WHERE view_id = ? AND status = ?
    `).get(viewId, status) ?? null
  ));
}

export function toView(record: ViewRecord): TranscriptView {
  return {
    viewId: transcriptViewId(record.view_id),
    status: record.status,
    createdAt: record.created_at,
    contentStartOrdinal: record.content_start_ordinal,
  };
}

export function closeConnection(entry: ConnectionEntry): ConnectionCloseAttempt {
  let checkpointFailure: Error | null = null;
  try {
    entry.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } catch (error) {
    checkpointFailure = asError(error);
  }
  try {
    entry.db.close();
  } catch (error) {
    return { closed: false, failure: asError(error) };
  }
  return { closed: true, checkpointFailure };
}
