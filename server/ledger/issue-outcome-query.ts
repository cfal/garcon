import type { Database } from 'bun:sqlite';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import { LedgerSchemaError } from './errors.js';

const outcomePredicate = `kind = 'notice'
  AND json_extract(payload_json, '$.value.detail.type') = 'issue-command-outcome'`;

export const ISSUE_OUTCOME_INDEX_SQL = `
  CREATE INDEX transcript_issue_outcome_correlation ON transcript_rows (
    view_id,
    json_extract(payload_json, '$.value.detail.requestViewId'),
    json_extract(payload_json, '$.value.detail.requestOrdinal'),
    ordinal
  ) WHERE ${outcomePredicate}
`;

export const ISSUE_OUTCOME_QUERY_SQL = `
  SELECT view_id, ordinal, kind, at, client_message_id, payload_json
  FROM transcript_rows INDEXED BY transcript_issue_outcome_correlation
  WHERE view_id = ? AND ${outcomePredicate}
    AND json_extract(payload_json, '$.value.detail.requestViewId') = ?
    AND json_extract(payload_json, '$.value.detail.requestOrdinal') = ?
  ORDER BY ordinal ASC LIMIT 1
`;

export function findIssueOutcomeOrdinal(db: Database, viewId: string, requestOrdinal: number): number | null {
  const stored = db.query<StoredLedgerRow, [string, string, number]>(ISSUE_OUTCOME_QUERY_SQL)
    .get(viewId, viewId, requestOrdinal);
  if (!stored) return null;
  const row = decodeStoredLedgerRow(stored);
  if (row.kind !== 'notice' || row.detail?.type !== 'issue-command-outcome'
    || row.detail.requestViewId !== viewId || row.detail.requestOrdinal !== requestOrdinal) {
    throw new LedgerSchemaError('Invalid issue outcome correlation');
  }
  return row.ordinal;
}
