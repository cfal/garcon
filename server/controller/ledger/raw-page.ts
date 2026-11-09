import type { Database } from 'bun:sqlite';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import type { TranscriptPage, TranscriptViewId } from './contracts.js';

export function readRawPage(db: Database, viewId: TranscriptViewId, limit: number, before?: number): TranscriptPage {
  const stored = before === undefined
    ? db.query<StoredLedgerRow, [string, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ?
        ORDER BY ordinal DESC
        LIMIT ?
      `).all(viewId, limit)
    : db.query<StoredLedgerRow, [string, number, number]>(`
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal < ?
        ORDER BY ordinal DESC
        LIMIT ?
      `).all(viewId, before, limit);
  const rows = stored.map(decodeStoredLedgerRow).reverse();
  const oldest = rows[0]?.ordinal ?? null;
  return {
    viewId,
    rows,
    nextBefore: oldest !== null && oldest > 1 ? oldest : null,
  };
}
