import type {
  TranscriptMessage,
  TranscriptPage as PresentedTranscriptPage,
  TranscriptReplayResult,
} from '../../common/chat-view.js';
import { CHAT_MESSAGES_MAX_LIMIT } from '../../common/chat-view.js';
import type { ChatMessage } from '../../common/chat-types.js';
import { TranscriptHistoryUnavailableError } from '../chats/errors.js';
import { DomainError } from '../lib/domain-error.js';
import type { TranscriptAdoptionService } from './adoption.js';
import type { TranscriptViewId } from './contracts.js';
import {
  InvalidTranscriptReplayRequestError,
  LedgerFencedError,
  StaleTranscriptViewError,
} from './errors.js';
import { ledgerRowsToMessages, ledgerRowsToTranscriptMessages } from './presentation.js';
import type { TranscriptLedgerService } from './service.js';

export class TranscriptViewReader {
  readonly #ledger: TranscriptLedgerService;
  readonly #adoption: TranscriptAdoptionService;

  constructor(
    ledger: TranscriptLedgerService,
    adoption: TranscriptAdoptionService,
  ) {
    this.#ledger = ledger;
    this.#adoption = adoption;
  }

  async page(
    chatId: string,
    limit: number,
    beforeOrdinal?: number,
    expectedTranscriptViewId?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PresentedTranscriptPage> {
    return readWithFenceTranslation(() => this.#page(
      chatId,
      limit,
      beforeOrdinal,
      expectedTranscriptViewId,
      signal,
    ));
  }

  async #page(
    chatId: string,
    limit: number,
    beforeOrdinal: number | undefined,
    expectedTranscriptViewId: string | undefined,
    signal: AbortSignal,
  ): Promise<PresentedTranscriptPage> {
    validatePageRequest(limit, beforeOrdinal);
    const view = await this.#adoption.ensure(chatId, signal);
    if (expectedTranscriptViewId && view.viewId !== expectedTranscriptViewId) {
      throw new StaleTranscriptViewError(chatId, expectedTranscriptViewId, view.viewId);
    }
    const highWatermark = this.#ledger.highWatermark(chatId).ordinal;
    const effectiveBefore = beforeOrdinal === undefined
      ? highWatermark + 1
      : Math.min(beforeOrdinal, highWatermark + 1);
    const pageNewestOrdinal = effectiveBefore - 1;
    signal.throwIfAborted();
    const rawPage = this.#ledger.page(chatId, view.viewId, limit, effectiveBefore);
    const messages: TranscriptMessage[] = ledgerRowsToTranscriptMessages(rawPage.rows);
    const nextBeforeOrdinal = rawPage.nextBefore;
    return {
      transcriptViewId: view.viewId,
      messages,
      lastOrdinal: highWatermark,
      pageOldestOrdinal: messages[0]?.ordinal ?? 0,
      pageNewestOrdinal,
      nextBeforeOrdinal,
      hasMore: nextBeforeOrdinal !== null,
    };
  }

  async replay(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    throughOrdinal?: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TranscriptReplayResult> {
    return readWithFenceTranslation(() => this.#replay(
      chatId,
      viewId,
      afterOrdinal,
      throughOrdinal,
      signal,
    ));
  }

  async #replay(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    throughOrdinal: number | undefined,
    signal: AbortSignal,
  ): Promise<TranscriptReplayResult> {
    signal.throwIfAborted();
    const currentView = await this.#adoption.ensure(chatId, signal);
    if (currentView.viewId !== viewId) {
      throw new StaleTranscriptViewError(chatId, viewId, currentView.viewId);
    }
    if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
      throw new InvalidTranscriptReplayRequestError(
        'Transcript replay cursor must be a non-negative safe integer',
      );
    }
    const highWatermark = this.#ledger.highWatermark(chatId).ordinal;
    const fixedWatermark = throughOrdinal ?? highWatermark;
    if (!Number.isSafeInteger(fixedWatermark) || fixedWatermark < afterOrdinal) {
      throw new InvalidTranscriptReplayRequestError(
        'Transcript replay watermark must not precede its cursor',
      );
    }
    if (fixedWatermark > highWatermark) {
      throw new InvalidTranscriptReplayRequestError(
        'Transcript replay watermark is ahead of the current view',
      );
    }
    const rows = this.#ledger.replayRows(
      chatId,
      viewId,
      afterOrdinal,
      fixedWatermark,
      CHAT_MESSAGES_MAX_LIMIT,
    );
    const nextAfterOrdinal = rows.at(-1)?.ordinal ?? afterOrdinal;
    if (nextAfterOrdinal === afterOrdinal && afterOrdinal < fixedWatermark) {
      throw new Error('Transcript replay page did not advance its cursor');
    }
    return {
      transcriptViewId: viewId,
      firstOrdinal: afterOrdinal + 1,
      lastOrdinal: nextAfterOrdinal,
      messages: ledgerRowsToTranscriptMessages(rows),
      nextAfterOrdinal,
      throughOrdinal: fixedWatermark,
      hasMore: nextAfterOrdinal < fixedWatermark,
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
    return readWithFenceTranslation(() => this.#renderingSnapshot(chatId, signal));
  }

  async #renderingSnapshot(
    chatId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly transcriptViewId: TranscriptViewId;
    readonly lastOrdinal: number;
    readonly messages: readonly ChatMessage[];
  }> {
    const view = await this.#adoption.ensure(chatId, signal);
    signal.throwIfAborted();
    const watermark = this.#ledger.highWatermark(chatId);
    if (watermark.viewId !== view.viewId) {
      throw new DomainError(
        'SOURCE_REVISION_CHANGED',
        'Transcript view changed while capturing the snapshot',
        409,
        true,
      );
    }
    const rows = this.#ledger.rowsThrough(chatId, watermark);
    return {
      transcriptViewId: view.viewId,
      lastOrdinal: watermark.ordinal,
      messages: ledgerRowsToMessages(rows),
    };
  }
}

async function readWithFenceTranslation<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof LedgerFencedError) {
      throw new TranscriptHistoryUnavailableError({
        kind: 'degraded',
        errorCode: 'LEDGER_FENCED',
        retryable: false,
      }, { cause: error });
    }
    throw error;
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
