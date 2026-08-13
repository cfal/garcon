import type {
  TranscriptMessage,
  TranscriptPage as PresentedTranscriptPage,
  TranscriptReplayResult,
} from '../../common/chat-view.js';
import type { ChatMessage } from '../../common/chat-types.js';
import type { TranscriptAdoptionService } from './adoption.js';
import type { TranscriptViewId } from './contracts.js';
import { ledgerRowsToTranscriptMessages } from './presentation.js';
import { ledgerRowsToMessages } from './presentation.js';
import type { TranscriptLedgerService } from './service.js';
import type { NativeTranscriptActivityService } from './native-activity.js';

const RAW_PAGE_SIZE = 256;

export class TranscriptViewReader {
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;
  readonly #nativeActivity: NativeTranscriptActivityService | null;

  constructor(
    ledger: TranscriptLedgerService,
    adoption: TranscriptAdoptionService,
    nativeActivity: NativeTranscriptActivityService | null = null,
  ) {
    this.#ledger = ledger;
    this.#adoption = adoption;
    this.#nativeActivity = nativeActivity;
  }

  async page(
    chatId: string,
    limit: number,
    beforeOrdinal?: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PresentedTranscriptPage> {
    validatePageRequest(limit, beforeOrdinal);
    const view = await this.#adoption.ensure(chatId, signal);
    if (beforeOrdinal === undefined) await this.#nativeActivity?.check(chatId, signal);
    const highWatermark = this.#ledger.highWatermark(chatId).ordinal;
    let before = beforeOrdinal === undefined
      ? highWatermark + 1
      : Math.min(beforeOrdinal, highWatermark + 1);
    const pageNewestOrdinal = before - 1;
    let messages: TranscriptMessage[] = [];

    while (messages.length <= limit && before > 1) {
      signal.throwIfAborted();
      const page = this.#ledger.page(chatId, view.viewId, RAW_PAGE_SIZE, before);
      const presented = ledgerRowsToTranscriptMessages(page.rows);
      messages = [...presented, ...messages];
      if (page.nextBefore === null) break;
      before = page.nextBefore;
    }

    const hasMore = messages.length > limit;
    if (hasMore) messages = messages.slice(-limit);
    return {
      transcriptViewId: view.viewId,
      messages,
      lastOrdinal: highWatermark,
      pageOldestOrdinal: messages[0]?.ordinal ?? 0,
      pageNewestOrdinal,
      hasMore,
    };
  }

  async replay(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TranscriptReplayResult> {
    signal.throwIfAborted();
    await this.#adoption.ensure(chatId, signal);
    const rows = this.#ledger.rowsAfter(chatId, viewId, afterOrdinal);
    const lastOrdinal = this.#ledger.highWatermark(chatId).ordinal;
    return {
      transcriptViewId: viewId,
      firstOrdinal: afterOrdinal + 1,
      lastOrdinal,
      messages: ledgerRowsToTranscriptMessages(rows),
    };
  }

  async renderingSnapshot(
    chatId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{
    readonly transcriptViewId: TranscriptViewId;
    readonly lastOrdinal: number;
    readonly messages: readonly ChatMessage[];
  }> {
    const view = await this.#adoption.ensure(chatId, signal);
    signal.throwIfAborted();
    const rows = this.#ledger.currentRows(chatId);
    return {
      transcriptViewId: view.viewId,
      lastOrdinal: rows.at(-1)?.ordinal ?? 0,
      messages: ledgerRowsToMessages(rows),
    };
  }
}

function validatePageRequest(limit: number, beforeOrdinal?: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('Transcript page limit must be between 1 and 1000');
  }
  if (
    beforeOrdinal !== undefined
    && (!Number.isSafeInteger(beforeOrdinal) || beforeOrdinal < 1)
  ) {
    throw new TypeError('Transcript page cursor must be a positive integer');
  }
}
