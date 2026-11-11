import type { Database } from 'bun:sqlite';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import {
  isTranscriptAnchor,
  type TranscriptAnchorDirection,
  type TranscriptAnchorPageStatus,
} from '../../../common/transcript-anchor-page.js';
import { decodeStoredLedgerRow, type StoredLedgerRow } from './codec.js';
import type { LedgerRow, TranscriptViewId } from './contracts.js';

const ANCHOR_SCAN_BATCH_ROWS = 200;

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

export interface AnchorScanProgress {
  readonly cursorOrdinal: number;
  readonly anchorsRemaining: number;
}

export interface AnchorBatchResult {
  readonly rows: LedgerRow[];
  readonly progress: AnchorScanProgress;
  readonly stop: 'yield' | 'complete' | 'exhausted';
}

// The store reacquires and validates ownership on every fenced read, including completion.
export async function readAnchorPage(
  viewId: TranscriptViewId,
  input: AnchorScanInput,
  read: <T>(work: (db: Database) => T) => T,
): Promise<AnchorScanResult> {
  const steps = new EventLoopSteps('ledger anchor page');
  const rows: LedgerRow[] = [];
  let progress: AnchorScanProgress = input;
  for (;;) {
    const batch = read(db => readAnchorBatch(db, viewId, input, progress, () => steps.due));
    rows.push(...batch.rows);
    progress = batch.progress;
    await steps.next();
    if (batch.stop === 'yield') continue;
    read(() => undefined);
    const backward = input.direction === 'backward';
    return {
      rows: backward ? rows.reverse() : rows,
      startOrdinal: backward ? progress.cursorOrdinal : input.cursorOrdinal + 1,
      endOrdinal: backward ? input.cursorOrdinal : progress.cursorOrdinal + 1,
      anchorsRemaining: progress.anchorsRemaining,
      pageStatus: batch.stop,
    };
  }
}

export function readAnchorBatch(
  db: Database,
  viewId: TranscriptViewId,
  input: AnchorScanInput,
  prior: AnchorScanProgress,
  shouldYield: () => boolean,
): AnchorBatchResult {
  const backward = input.direction === 'backward';
  const rows: LedgerRow[] = [];
  let cursorOrdinal = prior.cursorOrdinal;
  let anchorsRemaining = prior.anchorsRemaining;
  const atEdge = () => backward ? cursorOrdinal === 1 : cursorOrdinal === input.watermarkOrdinal;
  const finish = (stop: AnchorBatchResult['stop']): AnchorBatchResult => ({
    rows, progress: { cursorOrdinal, anchorsRemaining }, stop,
  });
  if (atEdge()) return finish('exhausted');
  const statement = db.query<StoredLedgerRow, [string, number, number, number]>(`
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ? AND ordinal ${backward ? '<' : '>'} ? AND ordinal <= ?
    ORDER BY ordinal ${backward ? 'DESC' : 'ASC'} LIMIT ?
  `);
  try {
    for (const stored of statement.iterate(viewId, cursorOrdinal, input.watermarkOrdinal, ANCHOR_SCAN_BATCH_ROWS)) {
      if (stored.ordinal !== cursorOrdinal + (backward ? -1 : 1)) {
        throw new Error('Transcript anchor scan encountered a noncontiguous raw interval');
      }
      const row = decodeStoredLedgerRow(stored);
      const anchor = row.kind === 'user-input'
        || (row.kind === 'provider-row' && isTranscriptAnchor(row.message));
      if (anchor && anchorsRemaining === 0) return finish('complete');
      rows.push(row);
      cursorOrdinal = row.ordinal;
      if (anchor) anchorsRemaining--;
      if (atEdge()) return finish('exhausted');
      if (shouldYield()) return finish('yield');
    }
  } finally {
    statement.finalize();
  }
  if (rows.length === ANCHOR_SCAN_BATCH_ROWS) return finish('yield');
  throw new Error('Transcript anchor scan ended before its fixed history edge');
}
