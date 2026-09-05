import type { Database } from 'bun:sqlite';
import {
  decodeStoredLedgerRow,
  submissionFingerprint,
  type StoredLedgerRow,
} from './codec.js';
import type {
  LedgerRow,
  LedgerUserInputDetail,
  LedgerUserInputRow,
  TranscriptViewId,
} from './contracts.js';
import { SubmissionConflictError } from './errors.js';
import { runQuery } from './sqlite-operations.js';

export function readSubmission(
  db: Database,
  viewId: TranscriptViewId,
  clientMessageId: string,
): LedgerRow | null {
  return runQuery(() => {
    const stored = db.query<StoredLedgerRow, [string, string]>(`
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND client_message_id = ?
    `).get(viewId, clientMessageId);
    return stored ? decodeStoredLedgerRow(stored) : null;
  });
}

export function matchingInputSubmission(
  db: Database,
  viewId: TranscriptViewId,
  detail: LedgerUserInputDetail,
): LedgerUserInputRow | null {
  if (!detail.clientMessageId) return null;
  const existing = readSubmission(db, viewId, detail.clientMessageId);
  if (!existing) return null;
  if (existing.kind !== 'user-input'
      || submissionFingerprint(existing.detail) !== submissionFingerprint(detail)) {
    throw new SubmissionConflictError(detail.clientMessageId);
  }
  return existing;
}
