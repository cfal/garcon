import type { ConnectionEntry } from './connection-entry.js';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import { isPresentationOnlyProviderRow, type LedgerUserInputRow, type TranscriptViewId } from './contracts.js';
import { runQuery } from './sqlite-operations.js';

export function readResendCandidates(entry: ConnectionEntry, viewId: TranscriptViewId): readonly LedgerUserInputRow[] {
  const statement = entry.db.query<StoredLedgerRow, [string]>(`
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ?
    ORDER BY ordinal DESC
  `);
  try {
    return collectResendCandidates(statement.iterate(viewId));
  } finally {
    statement.finalize();
  }
}

export function composeInputPrompt(
  entry: ConnectionEntry,
  viewId: TranscriptViewId,
  current: LedgerUserInputRow,
  excludedOrdinals: ReadonlySet<number> | undefined,
): readonly LedgerUserInputRow[] {
  return runQuery(() => {
    const statement = entry.db.query<StoredLedgerRow, [string, number]>(`
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND ordinal < ?
      ORDER BY ordinal DESC
    `);
    try {
      const preceding = collectResendCandidates(
        statement.iterate(viewId, current.ordinal),
        excludedOrdinals,
      );
      return [...preceding, current];
    } finally {
      statement.finalize();
    }
  });
}

function collectResendCandidates(
  storedRows: Iterable<StoredLedgerRow>,
  excludedOrdinals?: ReadonlySet<number>,
): readonly LedgerUserInputRow[] {
  const candidates: LedgerUserInputRow[] = [];
  for (const stored of storedRows) {
    const row = decodeStoredLedgerRow(stored);
    if (row.kind === 'user-input') {
      if (row.detail.message.metadata?.contentMode !== 'literal' && !excludedOrdinals?.has(row.ordinal)) candidates.unshift(row);
      continue;
    }
    if (row.kind === 'run-ended' && row.outcome === 'interrupted') continue;
    if (isPresentationOnlyProviderRow(row)) continue;
    if (row.kind === 'provider-row'
        || row.kind === 'permission-requested'
        || row.kind === 'run-ended') break;
  }
  return candidates;
}
