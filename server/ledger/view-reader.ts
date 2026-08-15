import type {
  TranscriptMessage,
  TranscriptPage as PresentedTranscriptPage,
  TranscriptReplayResult,
} from '../../common/chat-view.js';
import { CHAT_MESSAGES_MAX_LIMIT } from '../../common/chat-view.js';
import type { ChatMessage } from '../../common/chat-types.js';
import { TranscriptHistoryUnavailableError } from '../chats/errors.js';
import type { TranscriptAdoptionService } from './adoption.js';
import type { TranscriptViewId } from './contracts.js';
import {
  InvalidTranscriptReplayRequestError,
  LedgerFencedError,
  StaleTranscriptViewError,
} from './errors.js';
import { ledgerRowsToMessages, ledgerRowsToTranscriptMessages } from './presentation.js';
import type { TranscriptLedgerService } from './service.js';

const RAW_PAGE_SIZE = 256;

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
    signal: AbortSignal = new AbortController().signal,
  ): Promise<PresentedTranscriptPage> {
    try {
      return await this.#page(chatId, limit, beforeOrdinal, signal);
    } catch (error) {
      if (error instanceof LedgerFencedError) {
        throw new TranscriptHistoryUnavailableError({
          kind: 'degraded',
          errorCode: 'LEDGER_FENCED',
          retryable: true,
        });
      }
      throw error;
    }
  }

  async #page(
    chatId: string,
    limit: number,
    beforeOrdinal: number | undefined,
    signal: AbortSignal,
  ): Promise<PresentedTranscriptPage> {
    validatePageRequest(limit, beforeOrdinal);
    const view = await this.#adoption.ensure(chatId, signal);
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
    throughOrdinal?: number,
    signal: AbortSignal = new AbortController().signal,
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
