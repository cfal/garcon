import type { Database } from 'bun:sqlite';
import { yieldToEventLoop } from '@garcon/server-agent-common/shared/event-loop';
import { createLogger } from '../../common/log.js';
import {
  decodeLedgerRow,
  decodeStoredLedgerRow,
  encodeLedgerDraft,
  type StoredLedgerRow,
} from './codec.js';
import type { ConnectionEntry } from './connection-entry.js';
import { viewRecord } from './connection-setup.js';
import type { LedgerRow, LedgerRowDraft, TranscriptViewId } from './contracts.js';
import { LedgerBulkOperationAbandonedError, LedgerSchemaError } from './errors.js';
import { runTransaction } from './sqlite-operations.js';

// Whole-history reads and writes proceed in bounded steps separated by event-loop turns, so a
// long transcript cannot stall WebSocket liveness or publication for other chats.
const BULK_WRITE_ROWS = 500;
const BULK_WRITE_BYTES = 2 * 1024 * 1024;
const BULK_READ_ROWS = 1000;
const BULK_READ_BYTES = 4 * 1024 * 1024;
const BULK_DELETE_ROWS = 2000;
const logger = createLogger('ledger:staging');

export interface EncodedDraft {
  readonly draft: LedgerRowDraft;
  readonly clientMessageId: string | null;
  readonly payloadJson: string;
}

type LedgerWrite = <T>(chatId: string, work: (entry: ConnectionEntry) => T) => T;

// Owns work that spans several transactions of one chat's ledger. Staging views stay inert
// until promotion, survive connection-cache reopens while an operation owns them, and are
// abandoned rather than reopened once their chat closes.
export class StagingViews {
  readonly #active = new Map<string, Set<string>>();
  readonly #generations = new Map<string, number>();

  constructor(private readonly write: LedgerWrite) {}

  fitsOneTransaction(rows: readonly LedgerRowDraft[]): boolean {
    return rows.length <= BULK_WRITE_ROWS;
  }

  retained(chatId: string): ReadonlySet<string> | undefined {
    return this.#active.get(chatId);
  }

  activeChatIds(): readonly string[] {
    return [...this.#active.keys()];
  }

  generation(chatId: string): number {
    return this.#generations.get(chatId) ?? 0;
  }

  abandon(chatId: string): void {
    this.#generations.set(chatId, this.generation(chatId) + 1);
    this.#active.delete(chatId);
  }

  retain(chatId: string, viewId: string): void {
    let views = this.#active.get(chatId);
    if (!views) {
      views = new Set();
      this.#active.set(chatId, views);
    }
    views.add(viewId);
  }

  release(chatId: string, viewId: string): void {
    const views = this.#active.get(chatId);
    if (!views) return;
    views.delete(viewId);
    if (views.size === 0) this.#active.delete(chatId);
  }

  begin(chatId: string, viewId: TranscriptViewId, contentStartOrdinal: number, createdAt: string): void {
    this.write(chatId, (entry) => {
      entry.db.query(`
        INSERT INTO transcript_views(view_id, status, created_at, content_start_ordinal)
        VALUES (?, 'staging', ?, ?)
      `).run(viewId, createdAt, contentStartOrdinal);
    });
    this.retain(chatId, viewId);
  }

  async insertRows(
    chatId: string,
    viewId: TranscriptViewId,
    drafts: readonly LedgerRowDraft[],
    generation: number,
  ): Promise<void> {
    const clientMessageIds = new Set<string>();
    let index = 0;
    while (index < drafts.length) {
      if (index > 0) await yieldToEventLoop();
      this.#assertGeneration(chatId, generation);
      const firstOrdinal = index + 1;
      const batch: EncodedDraft[] = [];
      let bytes = 0;
      while (index < drafts.length && batch.length < BULK_WRITE_ROWS && bytes < BULK_WRITE_BYTES) {
        const encoded = encodeDraft(drafts[index]!, clientMessageIds);
        batch.push(encoded);
        bytes += encoded.payloadJson.length;
        index += 1;
      }
      materializeRows(viewId, batch, firstOrdinal);
      this.write(chatId, (entry) => {
        if (!viewRecord(entry.db, viewId, 'staging')) {
          throw new LedgerSchemaError('Transcript staging view was discarded');
        }
        runTransaction(entry.db, () => insertEncodedRows(entry.db, viewId, batch, firstOrdinal));
      });
    }
  }

  // Deletes an inert staging view in bounded transactions. Abandons quietly when the chat
  // closes after the owning operation began; open-time cleanup removes whatever remains.
  async discard(chatId: string, viewId: TranscriptViewId, generation = this.generation(chatId)): Promise<void> {
    try {
      for (;;) {
        this.#assertGeneration(chatId, generation);
        const finished = this.write(chatId, (entry) => {
          if (!viewRecord(entry.db, viewId, 'staging')) return true;
          return runTransaction(entry.db, () => {
            const deleted = entry.db.query(`
              DELETE FROM transcript_rows
              WHERE view_id = ? AND ordinal IN (
                SELECT ordinal FROM transcript_rows WHERE view_id = ? ORDER BY ordinal LIMIT ?
              )
            `).run(viewId, viewId, BULK_DELETE_ROWS).changes;
            if (deleted >= BULK_DELETE_ROWS) return false;
            entry.db.query("DELETE FROM transcript_views WHERE status = 'staging' AND view_id = ?").run(viewId);
            return true;
          });
        });
        if (finished) return;
        await yieldToEventLoop();
      }
    } catch (error) {
      if (!(error instanceof LedgerBulkOperationAbandonedError)) {
        logger.warn('Transcript staging view cleanup failed; it is removed on the next open', chatId, error);
      }
    } finally {
      if (this.generation(chatId) === generation) this.release(chatId, viewId);
    }
  }

  #assertGeneration(chatId: string, generation: number): void {
    if (this.generation(chatId) !== generation) throw new LedgerBulkOperationAbandonedError(chatId);
  }
}

export function encodeDrafts(drafts: readonly LedgerRowDraft[]): readonly EncodedDraft[] {
  const clientMessageIds = new Set<string>();
  return drafts.map((draft) => encodeDraft(draft, clientMessageIds));
}

// Tracks client message IDs across every batch of one view, like the view's unique index.
function encodeDraft(draft: LedgerRowDraft, clientMessageIds: Set<string>): EncodedDraft {
  const encoded = { draft, ...encodeLedgerDraft(draft) };
  if (encoded.clientMessageId) {
    if (clientMessageIds.has(encoded.clientMessageId)) {
      throw new LedgerSchemaError('Transcript view contains duplicate client message IDs');
    }
    clientMessageIds.add(encoded.clientMessageId);
  }
  return encoded;
}

export function materializeRows(
  viewId: TranscriptViewId,
  rows: readonly EncodedDraft[],
  firstOrdinal: number,
): readonly LedgerRow[] {
  return rows.map((item, index) => decodeLedgerRow({
    view_id: viewId,
    ordinal: firstOrdinal + index,
    kind: item.draft.kind,
    at: item.draft.at,
    client_message_id: item.clientMessageId,
    payload_json: item.payloadJson,
  }));
}

export function insertEncodedRows(
  db: Database,
  viewId: TranscriptViewId,
  rows: readonly EncodedDraft[],
  firstOrdinal: number,
): void {
  const insert = db.query(`
    INSERT INTO transcript_rows(
      view_id, ordinal, kind, at, client_message_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  rows.forEach((row, index) => {
    insert.run(
      viewId,
      firstOrdinal + index,
      row.draft.kind,
      row.draft.at,
      row.clientMessageId,
      row.payloadJson,
    );
  });
}

export function readBoundedPage(
  db: Database,
  viewId: TranscriptViewId,
  afterOrdinal: number,
  throughOrdinal: number,
): { readonly rows: readonly LedgerRow[]; readonly exhausted: boolean } {
  const statement = db.prepare<StoredLedgerRow, [string, number, number]>(`
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ? AND ordinal > ? AND ordinal <= ?
    ORDER BY ordinal
  `);
  try {
    const rows: LedgerRow[] = [];
    let bytes = 0;
    for (const stored of statement.iterate(viewId, afterOrdinal, throughOrdinal)) {
      rows.push(decodeStoredLedgerRow(stored));
      bytes += stored.payload_json.length;
      if (rows.length >= BULK_READ_ROWS || bytes >= BULK_READ_BYTES) return { rows, exhausted: false };
    }
    return { rows, exhausted: true };
  } finally {
    statement.finalize();
  }
}
