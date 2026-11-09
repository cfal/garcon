import type { Database } from 'bun:sqlite';
import {
  isTranscriptAnchor,
  TRANSCRIPT_ANCHOR_RAW_LIMIT,
  type TranscriptAnchorDirection,
  type TranscriptAnchorPageStatus,
} from '../../../common/transcript-anchor-page.js';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import type { LedgerRow, TranscriptViewId } from './contracts.js';

export const TRANSCRIPT_ANCHOR_BYTE_TARGET = 1024 * 1024;

export interface AnchorScanInput {
  readonly direction: TranscriptAnchorDirection;
  readonly cursorOrdinal: number;
  readonly watermarkOrdinal: number;
  readonly anchorsRemaining: number;
}

export interface AnchorScanResult {
  readonly rows: LedgerRow[];
  readonly startOrdinal: number;
  readonly endOrdinal: number;
  readonly anchorsRemaining: number;
  readonly pageStatus: TranscriptAnchorPageStatus;
}

export function readAnchorPage(db: Database, viewId: TranscriptViewId, input: AnchorScanInput): AnchorScanResult {
  const backward = input.direction === 'backward';
  const statement = db.query<StoredLedgerRow, [string, number, number, number]>(`
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ? AND ordinal ${backward ? '<' : '>'} ? AND ordinal <= ?
    ORDER BY ordinal ${backward ? 'DESC' : 'ASC'} LIMIT ?
  `);
  const rows: LedgerRow[] = [];
  let cursor = input.cursorOrdinal;
  let anchorsRemaining = input.anchorsRemaining;
  let bytes = 0;
  let pageStatus: TranscriptAnchorPageStatus = 'partial';
  try {
    for (const stored of statement.iterate(viewId, cursor, input.watermarkOrdinal, TRANSCRIPT_ANCHOR_RAW_LIMIT + 1)) {
      if (stored.ordinal !== cursor + (backward ? -1 : 1)) {
        throw new Error('Transcript anchor scan encountered a noncontiguous raw interval');
      }
      const row = decodeStoredLedgerRow(stored);
      const anchor = row.kind === 'user-input'
        || (row.kind === 'provider-row' && isTranscriptAnchor(row.message));
      // Boundary lookahead wins over transport limits; it is never consumed.
      if (anchor && anchorsRemaining === 0) {
        pageStatus = 'complete';
        break;
      }
      const size = Buffer.byteLength(stored.payload_json, 'utf8');
      if (rows.length > 0 && (rows.length === TRANSCRIPT_ANCHOR_RAW_LIMIT || bytes + size > TRANSCRIPT_ANCHOR_BYTE_TARGET)) {
        break;
      }
      rows.push(row);
      bytes += size;
      cursor = row.ordinal;
      if (anchor) anchorsRemaining--;
    }
  } finally {
    statement.finalize();
  }
  const startOrdinal = backward ? cursor : input.cursorOrdinal + 1;
  const endOrdinal = backward ? input.cursorOrdinal : cursor + 1;
  if (backward ? startOrdinal === 1 : endOrdinal === input.watermarkOrdinal + 1) {
    pageStatus = 'exhausted';
  } else if (rows.length === 0 && pageStatus !== 'complete') {
    throw new Error('Transcript anchor scan did not advance its raw interval');
  }
  return {
    rows: backward ? rows.reverse() : rows,
    startOrdinal,
    endOrdinal,
    anchorsRemaining,
    pageStatus,
  };
}
