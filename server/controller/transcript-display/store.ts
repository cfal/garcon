import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { chmodSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { StoredLedgerRow } from '../ledger/codec.js';
import { DISPLAY_POLICY_REVISION } from '../../../common/transcript-display-policy.js';
import { invalidDisplayStore } from './errors.js';

export const DISPLAY_STORE_FORMAT = 2;
export interface DisplayManifest {
  chat_id: string;
  view_id: string;
  policy_revision: number;
  written_by_server_instance: string;
  prepared_through: number;
  frontier_fingerprint: string;
  last_gap_ordinal: number;
  captured_goal: number;
}

export function sourceFingerprint(row: StoredLedgerRow | null): string {
  return createHash('sha256').update(JSON.stringify(row === null ? ['empty-prefix']
    : [row.view_id, row.ordinal, row.kind, row.at, row.client_message_id, row.payload_json])).digest('hex');
}

export function contentDigest(content: string): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export class DisplayStore {
  readonly db: Database;
  statements = 0;

  constructor(readonly path: string, readonly readonly = false) {
    if (path !== ':memory:') {
      try { if (lstatSync(path).isSymbolicLink()) throw new Error('Display database cannot be a symlink'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    this.db = new Database(path, { readonly, create: !readonly, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout = 50; PRAGMA cache_size = -2048; PRAGMA foreign_keys = ON;');
      if (!readonly) {
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
        const version = this.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
        if (version === 0) this.db.transaction(() => { this.db.exec(SCHEMA); this.db.exec(`PRAGMA user_version = ${DISPLAY_STORE_FORMAT}`); })();
        else if (version !== DISPLAY_STORE_FORMAT) throw invalidDisplayStore('Display schema version mismatch');
        if (path !== ':memory:') chmodSync(path, 0o600);
      } else if (this.get<{ user_version: number }>('PRAGMA user_version')!.user_version !== DISPLAY_STORE_FORMAT) {
        throw invalidDisplayStore('Display schema version mismatch');
      }
    } catch (error) { this.db.close(); throw error; }
  }

  get<T>(sql: string, ...args: SQLQueryBindings[]): T | null {
    this.statements++;
    return this.db.query<T, SQLQueryBindings[]>(sql).get(...args);
  }
  all<T>(sql: string, ...args: SQLQueryBindings[]): T[] {
    this.statements++;
    return this.db.query<T, SQLQueryBindings[]>(sql).all(...args);
  }
  run(sql: string, ...args: SQLQueryBindings[]): void {
    this.statements++;
    this.db.query(sql).run(...args);
  }
  manifest(): DisplayManifest | null { return this.get<DisplayManifest>('SELECT * FROM manifest WHERE singleton = 1'); }
  initialize(chatId: string, viewId: string, serverInstanceId: string): void {
    const existing = this.manifest();
    if (existing) {
      if (existing.chat_id !== chatId || existing.view_id !== viewId || existing.policy_revision !== DISPLAY_POLICY_REVISION) throw invalidDisplayStore('Display identity mismatch');
      return;
    }
    this.run('INSERT INTO manifest VALUES (1, ?, ?, ?, ?, 0, ?, 0, 0)', chatId, viewId,
      DISPLAY_POLICY_REVISION, serverInstanceId, sourceFingerprint(null));
  }
  close(): void { this.db.close(); }
}

const SCHEMA = `
CREATE TABLE manifest (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), chat_id TEXT NOT NULL, view_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL, written_by_server_instance TEXT NOT NULL, prepared_through INTEGER NOT NULL,
  frontier_fingerprint TEXT NOT NULL, last_gap_ordinal INTEGER NOT NULL, captured_goal INTEGER NOT NULL
) STRICT;
CREATE TABLE feature (
  ordinal INTEGER PRIMARY KEY, role TEXT NOT NULL, class_id INTEGER, message_type TEXT,
  permission_occurrence TEXT, command_id TEXT, command_markdown INTEGER NOT NULL,
  estimated_body_bytes INTEGER NOT NULL, submission_id TEXT
) STRICT;
CREATE TABLE class_tail (class_id INTEGER PRIMARY KEY, rank INTEGER NOT NULL, cumulative_weight INTEGER NOT NULL) STRICT;
CREATE TABLE posting (class_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, rank INTEGER NOT NULL,
  cumulative_weight INTEGER NOT NULL, PRIMARY KEY(class_id, ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE pending_use (tool_id TEXT NOT NULL, use_ordinal INTEGER NOT NULL, tool_type TEXT NOT NULL,
  empty_required_input INTEGER NOT NULL, is_question INTEGER NOT NULL, wrapper_ordinal INTEGER,
  PRIMARY KEY(tool_id, use_ordinal)) WITHOUT ROWID, STRICT;
CREATE INDEX pending_unwrapped_question ON pending_use(tool_id, use_ordinal) WHERE is_question = 1 AND wrapper_ordinal IS NULL;
CREATE TABLE pending_wrapper (tool_id TEXT NOT NULL, wrapper_ordinal INTEGER NOT NULL,
  PRIMARY KEY(tool_id, wrapper_ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE tool_pair (use_ordinal INTEGER PRIMARY KEY, result_ordinal INTEGER NOT NULL UNIQUE,
  wrapper_ordinal INTEGER, evidence_ordinal INTEGER NOT NULL) STRICT;
CREATE TABLE permission_terminal (occurrence_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(occurrence_id, ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE command_evidence (command_id TEXT NOT NULL, evidence_ordinal INTEGER NOT NULL,
  first_output_ordinal INTEGER, stdout_count INTEGER NOT NULL, result_count INTEGER NOT NULL,
  last_result_ordinal INTEGER, last_result_complete INTEGER NOT NULL, last_gap_at_result INTEGER NOT NULL,
  PRIMARY KEY(command_id, evidence_ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE bash_input (use_ordinal INTEGER PRIMARY KEY, command TEXT NOT NULL) STRICT;
CREATE TABLE bash_event (ordinal INTEGER PRIMARY KEY, use_ordinal INTEGER NOT NULL, class_id INTEGER NOT NULL, weight INTEGER NOT NULL) STRICT;
CREATE TABLE bash_revision (revision TEXT PRIMARY KEY, prepared_through INTEGER NOT NULL, status TEXT NOT NULL, failure_code TEXT) STRICT;
CREATE TABLE bash_decision (revision TEXT NOT NULL, use_ordinal INTEGER NOT NULL, eligible INTEGER NOT NULL,
  PRIMARY KEY(revision, use_ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE bash_posting (revision TEXT NOT NULL, class_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, rank INTEGER NOT NULL,
  cumulative_weight INTEGER NOT NULL, PRIMARY KEY(revision, class_id, ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE public_tail (ordinal INTEGER PRIMARY KEY, message_type TEXT NOT NULL, content_digest TEXT,
  combined_digest TEXT, failed_result INTEGER NOT NULL) STRICT;
CREATE TABLE user_navigation (ordinal INTEGER PRIMARY KEY, preview TEXT NOT NULL, timestamp TEXT NOT NULL,
  nonblank INTEGER NOT NULL, attachment_count INTEGER NOT NULL, presentation_json TEXT) STRICT;
CREATE INDEX user_recall ON user_navigation(ordinal) WHERE nonblank = 1;
CREATE TABLE resend_boundary (ordinal INTEGER PRIMARY KEY) STRICT;
CREATE TABLE resend_input (ordinal INTEGER PRIMARY KEY, rank INTEGER NOT NULL) STRICT;
CREATE TABLE auxiliary_fact (ordinal INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT;
CREATE INDEX auxiliary_kind ON auxiliary_fact(kind, ordinal);
CREATE TABLE auxiliary_result (tool_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY(tool_id, ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE auxiliary_fingerprint (fingerprint TEXT NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(fingerprint, ordinal)) WITHOUT ROWID, STRICT;
CREATE TABLE auxiliary_tool (tool_id TEXT PRIMARY KEY) WITHOUT ROWID, STRICT;
CREATE TABLE auxiliary_control (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), published INTEGER NOT NULL,
  generation INTEGER NOT NULL, building INTEGER NOT NULL, relevant_through INTEGER NOT NULL,
  phase TEXT NOT NULL, cursor INTEGER NOT NULL, event_order INTEGER NOT NULL) STRICT;
INSERT INTO auxiliary_control VALUES(1, 0, 0, 0, 0, 'idle', 0, 0);
CREATE TABLE auxiliary_known_alias (generation INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(generation, alias)) WITHOUT ROWID, STRICT;
CREATE TABLE auxiliary_alias (generation INTEGER NOT NULL, alias TEXT NOT NULL, entry_key TEXT NOT NULL,
  PRIMARY KEY(generation, alias)) WITHOUT ROWID, STRICT;
CREATE TABLE auxiliary_redirect (generation INTEGER NOT NULL, entry_key TEXT NOT NULL, target TEXT NOT NULL,
  PRIMARY KEY(generation, entry_key)) WITHOUT ROWID, STRICT;
CREATE TABLE auxiliary_entry (generation INTEGER NOT NULL, entry_key TEXT NOT NULL, created_order INTEGER NOT NULL,
  payload_json TEXT NOT NULL, PRIMARY KEY(generation, entry_key)) WITHOUT ROWID, STRICT;
CREATE INDEX auxiliary_entry_order ON auxiliary_entry(generation, created_order);
`;
