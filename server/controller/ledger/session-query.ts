import type { Database } from 'bun:sqlite';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import type { LedgerSessionRow, TranscriptView } from './contracts.js';

// A view's session row usually sits near its start, so a newest-first search
// without this index reads the whole view on every transcript read.
export const SESSION_INDEX_SQL = `
  CREATE INDEX transcript_session_rows ON transcript_rows (view_id, ordinal)
  WHERE kind = 'session'
`;

// Without statistics the planner prefers the primary key, so the index is named.
export const CURRENT_SESSION_QUERY_SQL = `
  SELECT view_id, ordinal, kind, at, client_message_id, payload_json
  FROM transcript_rows INDEXED BY transcript_session_rows
  WHERE view_id = ? AND ordinal >= ? AND kind = 'session'
  ORDER BY ordinal DESC LIMIT 1
`;

export function findCurrentSession(db: Database, view: TranscriptView): LedgerSessionRow | null {
  const stored = db.query<StoredLedgerRow, [string, number]>(CURRENT_SESSION_QUERY_SQL)
    .get(view.viewId, view.contentStartOrdinal);
  return stored ? decodeStoredLedgerRow(stored) as LedgerSessionRow : null;
}
