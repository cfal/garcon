import type { Database } from 'bun:sqlite';
import { yieldToEventLoop } from '@garcon/server-agent-common/shared/event-loop';
import { hasNodeErrorCode } from '../../common/errors.js';
import type { StoredLedgerRow } from './codec.js';
import type { TranscriptViewId, TranscriptWatermark } from './contracts.js';
import { UNDECODABLE_LEDGER_ROW } from './errors.js';
import { readBoundedStoredPage, type BoundedPage } from './staging-views.js';

interface StoredReadPort {
  read<T>(chatId: string, viewId: TranscriptViewId, work: (database: Database) => T): T;
  captureGuard(chatId: string): () => void;
}
type PageReader<Row> = (database: Database, viewId: TranscriptViewId, after: number, through: number) => BoundedPage<Row>;

export class StoredLedgerReads {
  constructor(private readonly port: StoredReadPort) {}

  submissionOrdinals(chatId: string, viewId: TranscriptViewId, clientMessageIds: readonly string[]) {
    if (clientMessageIds.length > 32 || clientMessageIds.some(id => typeof id !== 'string' || !id.length || id.length > 256)) {
      throw new TypeError('Invalid submission lookup');
    }
    return this.port.read(chatId, viewId, database => {
      const query = database.query<{ ordinal: number; kind: string }, [string, string]>(
        'SELECT ordinal, kind FROM transcript_rows WHERE view_id = ? AND client_message_id = ? AND client_message_id IS NOT NULL');
      return clientMessageIds.map(clientMessageId => {
        const row = query.get(viewId, clientMessageId);
        return { clientMessageId, ordinal: row?.kind === 'user-input' ? row.ordinal : null };
      });
    });
  }

  async withFrames<T>(chatId: string, watermark: TranscriptWatermark, fromOrdinal: number,
    consume: (frames: AsyncIterable<readonly StoredLedgerRow[]>) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const assertActive = this.port.captureGuard(chatId);
    const read: PageReader<StoredLedgerRow> = (database, viewId, after, through) =>
      readBoundedStoredPage(database, viewId, after, through, { rows: 256, bytes: 2 * 1024 * 1024 });
    return this.#consume(chatId, watermark, assertActive, () => consume(this.streamPages(chatId, watermark, read, signal, fromOrdinal)), signal);
  }

  byOrdinals(chatId: string, watermark: TranscriptWatermark, ordinals: readonly number[]): readonly StoredLedgerRow[] {
    if (ordinals.length > 200 || ordinals.some(ordinal => !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > watermark.ordinal)) {
      throw new TypeError('Invalid bounded transcript address request');
    }
    return this.port.read(chatId, watermark.viewId, database => {
      const query = database.query<StoredLedgerRow, [string, number]>(
        'SELECT view_id, ordinal, kind, at, client_message_id, payload_json FROM transcript_rows WHERE view_id = ? AND ordinal = ?',
      );
      return [...new Set(ordinals)].flatMap(ordinal => {
        const row = query.get(watermark.viewId, ordinal);
        return row ? [row] : [];
      });
    });
  }

  async withOrdinals<T>(chatId: string, watermark: TranscriptWatermark, ordinals: readonly number[],
    consume: (rows: readonly StoredLedgerRow[]) => Promise<T>): Promise<T> {
    const assertActive = this.port.captureGuard(chatId);
    const rows = this.byOrdinals(chatId, watermark, ordinals);
    return this.#consume(chatId, watermark, assertActive, () => consume(rows));
  }

  async #consume<T>(chatId: string, watermark: TranscriptWatermark, assertActive: () => void,
    work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      const result = await work();
      signal?.throwIfAborted();
      assertActive();
      this.port.read(chatId, watermark.viewId, () => undefined);
      return result;
    } catch (error) {
      if (!hasNodeErrorCode(error, UNDECODABLE_LEDGER_ROW)) throw error;
      assertActive();
      return this.port.read(chatId, watermark.viewId, () => { throw error; });
    }
  }

  async pagesThrough<Row extends { readonly ordinal: number }>(chatId: string, watermark: TranscriptWatermark,
    read: PageReader<Row>, signal?: AbortSignal): Promise<readonly Row[]> {
    const rows: Row[] = [];
    for await (const page of this.streamPages(chatId, watermark, read, signal)) rows.push(...page);
    return rows;
  }

  // View-qualified immutable rows remain consistent across event-loop turns without a held transaction.
  async *streamPages<Row extends { readonly ordinal: number }>(chatId: string, watermark: TranscriptWatermark,
    read: PageReader<Row>, signal?: AbortSignal, fromOrdinal = 1): AsyncGenerator<readonly Row[]> {
    if (!Number.isSafeInteger(watermark.ordinal) || watermark.ordinal < 0) throw new TypeError('Transcript watermark ordinal is invalid');
    if (!Number.isSafeInteger(fromOrdinal) || fromOrdinal < 1) throw new TypeError('Transcript starting ordinal is invalid');
    let after = fromOrdinal - 1;
    const assertActive = this.port.captureGuard(chatId);
    for (;;) {
      signal?.throwIfAborted();
      assertActive();
      const page = this.port.read(chatId, watermark.viewId, database => read(database, watermark.viewId, after, watermark.ordinal));
      yield page.rows;
      signal?.throwIfAborted();
      assertActive();
      if (page.exhausted) {
        this.port.read(chatId, watermark.viewId, () => undefined);
        return;
      }
      after = page.rows[page.rows.length - 1]!.ordinal;
      await yieldToEventLoop();
    }
  }
}
