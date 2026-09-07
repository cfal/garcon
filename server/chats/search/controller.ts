import {
  CHAT_SEARCH_DEFAULT_PAGE_SIZE,
  CHAT_SEARCH_MAX_OFFSET,
  CHAT_SEARCH_MAX_PAGE_SIZE,
  CHAT_SEARCH_MAX_PREFIX_SIZE,
  CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT,
  CHAT_SEARCH_MIN_PREFIX_CHARS,
  type ChatSearchIndexStatus,
  type ChatSearchPage,
  type ChatSearchQueryV1,
  type ChatSearchResult,
  type ChatSearchResultMode,
  type ChatSearchSort,
  type TranscriptSearchAllowedChat,
  type TranscriptSearchStatusV1,
} from '@garcon/common/chat-search';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { projectSearchMessage } from '@garcon/server-agent-common/search/message-projector';
import type { HistoricalSearchMessageRow } from '@garcon/server-agent-common/search/rows';
import type { SearchChatState } from '@garcon/server-agent-common/search/schema';
import type {
  TranscriptSearchQueryStats,
  TranscriptSearchService,
  TranscriptSearchSyncFrame,
} from '@garcon/server-agent-common/search/transcript-search-service';
import {
  transcriptViewId,
  type LedgerRow,
  type TranscriptView,
  type TranscriptViewId,
} from '../../ledger/contracts.js';
import {
  LedgerFencedError,
  StaleTranscriptViewError,
  safeFenceDiagnostic,
} from '../../ledger/errors.js';
import type {
  TranscriptCommitEvent,
  TranscriptLedgerService,
} from '../../ledger/service.js';
import type { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { TranscriptSearchUnavailableError } from './errors.js';

const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
const LEDGER_PAGE_ROWS = 512;
const LEDGER_FENCED_VIEW_SENTINEL: TranscriptViewId = transcriptViewId('ledger-fenced');
const LEDGER_UNADOPTED_VIEW_SENTINEL: TranscriptViewId = transcriptViewId('ledger-unadopted');

export interface TranscriptSearchControllerDeps {
  readonly listChatIds: () => readonly string[];
  readonly hasChat: (chatId: string) => boolean;
  readonly ledger: Pick<
    TranscriptLedgerService,
    'existingCurrentView' | 'highWatermark' | 'replayRows' | 'subscribe'
  >;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly service: TranscriptSearchService;
  readonly logger: Pick<AgentLogger, 'warn' | 'info'>;
  readonly searchTimeoutMs?: number;
}

export class TranscriptSearchController {
  readonly #deps: TranscriptSearchControllerDeps;
  readonly #lifecycleAbort = new AbortController();
  readonly #chatTails = new Map<string, Promise<void>>();
  readonly #ingestPacer = new IngestPacer();
  readonly #indexedViews = new Map<
    string,
    { viewId: TranscriptViewId; through: number }
  >();
  readonly #ledgerSnapshots = new Map<
    string,
    { viewId: TranscriptViewId; through: number }
  >();
  readonly #adoptionFailedChatIds = new Set<string>();
  readonly #adoptingChatIds = new Set<string>();
  readonly #fencedChatIds = new Set<string>();
  readonly #unsubscribe: () => void;
  #resyncTail: Promise<void> = Promise.resolve();
  #enabled = false;
  #admissionFailed = false;
  #closed = false;
  #enableAbort: AbortController | null = null;

  constructor(deps: TranscriptSearchControllerDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.ledger.subscribe((event) => this.#onCommit(event));
    deps.service.setResyncHandler(() => this.#trackResync());
  }

  #trackResync(): Promise<void> {
    const run = this.#resyncTail
      .catch(() => undefined)
      .then(() => this.#resyncAll())
      .catch((error) => this.#warnCatalogFailure('synchronization', error));
    this.#resyncTail = run;
    return run;
  }

  async initialize(enabled: boolean): Promise<void> {
    if (enabled) await this.start();
    else await this.disableAndDelete();
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('Transcript search controller is closed');
    if (this.#enabled) return;
    const enableAbort = new AbortController();
    this.#enableAbort = enableAbort;
    try {
      await this.#deps.service.enable(this.#lifecycleAbort.signal);
    } catch (error) {
      enableAbort.abort();
      if (this.#enableAbort === enableAbort) this.#enableAbort = null;
      this.#enabled = false;
      this.#admissionFailed = true;
      throw error;
    }
    this.#enabled = true;
    this.#admissionFailed = false;
    void this.#trackResync();
  }

  status(): TranscriptSearchStatusV1 {
    return this.#deps.service.status();
  }

  queryStats(): TranscriptSearchQueryStats {
    return this.#deps.service.queryStats();
  }

  onStatusChanged(listener: (status: TranscriptSearchStatusV1) => void): () => void {
    return this.#deps.service.onStatusChanged(listener);
  }

  catalogMayHaveChanged(chatId: string): void {
    this.#adoptionFailedChatIds.delete(chatId);
    if (!this.#enabled || this.#closed) return;
    this.#deps.service.setCatalogChatTotal(this.#deps.listChatIds().length);
    if (this.#adoptingChatIds.has(chatId)) return;
    this.#schedule(chatId, 'catalog-refresh', () => this.#syncCatalogChat(chatId));
  }

  deleteChat(chatId: string): void {
    this.#forgetChat(chatId);
    if (!this.#enabled || this.#closed) return;
    this.#deps.service.setCatalogChatTotal(this.#deps.listChatIds().length);
    this.#schedule(chatId, 'delete', () => this.#deps.service.deleteChat(chatId));
  }

  async search(options: {
    readonly query: string;
    readonly textTokens?: string[];
    readonly allowedChatIds: string[];
    readonly sort: ChatSearchSort;
    readonly mode?: ChatSearchResultMode;
    readonly offset: number;
    readonly limit?: number;
    readonly snippetLimit?: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    mode: ChatSearchResultMode;
    snippetLimit: number;
    results: ChatSearchResult[];
    page: ChatSearchPage;
    index: ChatSearchIndexStatus;
  }> {
    if (!this.#enabled || this.#closed) {
      const unavailable = this.#admissionFailed || this.#closed;
      throw new TranscriptSearchUnavailableError(
        unavailable ? 'SEARCH_INDEX_UNAVAILABLE' : 'TRANSCRIPT_SEARCH_DISABLED',
        unavailable ? 'Transcript search is unavailable' : 'Transcript search is disabled',
        unavailable,
      );
    }
    const executionAbort = new AbortController();
    const enableSignal = this.#enableAbort?.signal;
    const abortExecution = () => executionAbort.abort();
    enableSignal?.addEventListener('abort', abortExecution, { once: true });
    if (enableSignal?.aborted) abortExecution();
    const timeout = setTimeout(
      abortExecution,
      this.#deps.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    );
    timeout.unref?.();
    try {
      options.signal?.throwIfAborted();
      executionAbort.signal.throwIfAborted();
      const allowedViews = new Map<string, TranscriptViewId>();
      const allowedChats: TranscriptSearchAllowedChat[] = [];
      const fencedChatIds = new Set<string>();
      const adoptionFailedChatIds = new Set<string>();
      let unindexedChatCount = 0;
      for (const chatId of new Set(options.allowedChatIds)) {
        const snapshot = this.#ledgerSnapshots.get(chatId) ?? null;
        if (!snapshot) {
          if (this.#fencedChatIds.has(chatId)) fencedChatIds.add(chatId);
          else if (this.#adoptionFailedChatIds.has(chatId)) adoptionFailedChatIds.add(chatId);
          else unindexedChatCount += 1;
          continue;
        }
        allowedViews.set(chatId, snapshot.viewId);
        allowedChats.push({
          chatId,
          transcriptViewId: snapshot.viewId,
          throughOrdinal: snapshot.through,
        });
      }
      const mode = options.mode ?? 'page';
      const snippetLimit = clampSnippetLimit(options.snippetLimit);
      const offset = clampOffset(options.offset);
      if (mode === 'prefix' && (offset !== 0 || snippetLimit !== 1)) {
        throw new RangeError('Invalid transcript search prefix projection');
      }
      const response = await this.#deps.service.search({
        query: compileQuery(options.query, options.textTokens),
        allowedChats,
        order: (options.sort ?? 'relevance') === 'relevance' ? 'relevance' : 'allowlist',
        mode,
        offset,
        limit: clampLimit(options.limit, mode),
        snippetLimit,
        admissionSignal: options.signal,
        executionSignal: executionAbort.signal,
      });
      return {
        mode: response.mode,
        snippetLimit: response.snippetLimit,
        results: response.results.filter((result) => (
          allowedViews.get(result.chatId) === result.transcriptViewId
          && this.validateResultView(result.chatId, result.transcriptViewId)
        )),
        page: response.page,
        index: {
          ...response.index,
          failedChatCount: response.index.failedChatCount
            + fencedChatIds.size
            + adoptionFailedChatIds.size,
          unindexedChatCount,
        },
      };
    } catch (error) {
      if (isAbortError(error) && options.signal?.aborted) throw error;
      throw translateSearchError(error, this.#deps.logger);
    } finally {
      clearTimeout(timeout);
      enableSignal?.removeEventListener('abort', abortExecution);
    }
  }

  validateResultView(chatId: string, transcriptViewId: string): boolean {
    if (!this.#enabled || this.#closed) return false;
    if (!this.#deps.hasChat(chatId)) return false;
    try {
      return this.#deps.ledger.existingCurrentView(chatId)?.viewId === transcriptViewId;
    } catch (error) {
      if (!(error instanceof LedgerFencedError)) throw error;
      return false;
    }
  }

  async disableAndDelete(): Promise<void> {
    this.#enabled = false;
    this.#admissionFailed = false;
    this.#enableAbort?.abort();
    this.#enableAbort = null;
    await this.#resyncTail.catch(() => undefined);
    await Promise.allSettled(this.#chatTails.values());
    this.#chatTails.clear();
    this.#indexedViews.clear();
    this.#ledgerSnapshots.clear();
    this.#adoptionFailedChatIds.clear();
    this.#adoptingChatIds.clear();
    this.#fencedChatIds.clear();
    await this.#deps.service.disableAndDelete(new AbortController().signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#enableAbort?.abort();
    this.#enableAbort = null;
    this.#lifecycleAbort.abort();
    this.#unsubscribe();
    await this.#resyncTail.catch(() => undefined);
    await Promise.allSettled(this.#chatTails.values());
    this.#chatTails.clear();
    this.#indexedViews.clear();
    this.#ledgerSnapshots.clear();
    this.#adoptionFailedChatIds.clear();
    this.#adoptingChatIds.clear();
    this.#fencedChatIds.clear();
    await this.#deps.service.close();
  }

  async #catalogSnapshot(
    chatId: string,
    operation: 'resync' | 'catalog-refresh',
  ): Promise<{ view: TranscriptView; through: number } | null> {
    try {
      let view = await this.#ingestPacer.pay(
        () => this.#deps.ledger.existingCurrentView(chatId),
      );
      if (!view) {
        this.#adoptingChatIds.add(chatId);
        try {
          const signal = this.#enableAbort?.signal ?? this.#lifecycleAbort.signal;
          const adopted = await this.#ingestPacer.pay(() => (
            this.#deps.hasChat(chatId)
              ? this.#deps.adoption.ensure(chatId, signal)
              : null
          ));
          if (!adopted) {
            this.#forgetChat(chatId);
            return null;
          }
          view = adopted;
        } finally {
          this.#adoptingChatIds.delete(chatId);
        }
      }
      const watermark = await this.#ingestPacer.pay(() => {
        if (!this.#deps.hasChat(chatId)) throw new Error('SEARCH_VIEW_MISMATCH');
        return this.#deps.ledger.highWatermark(chatId);
      });
      if (watermark.viewId !== view.viewId) throw new Error('SEARCH_VIEW_MISMATCH');
      if (!this.#deps.hasChat(chatId)) {
        this.#forgetChat(chatId);
        return null;
      }
      this.#ledgerSnapshots.set(chatId, { viewId: view.viewId, through: watermark.ordinal });
      this.#adoptionFailedChatIds.delete(chatId);
      this.#fencedChatIds.delete(chatId);
      return { view, through: watermark.ordinal };
    } catch (error) {
      this.#adoptingChatIds.delete(chatId);
      this.#indexedViews.delete(chatId);
      this.#ledgerSnapshots.delete(chatId);
      if (isAbortError(error) && (!this.#enabled || this.#closed)) throw error;
      if (!this.#deps.hasChat(chatId)) {
        this.#forgetChat(chatId);
        return null;
      }
      const fenced = error instanceof LedgerFencedError;
      if (fenced) {
        this.#fencedChatIds.add(chatId);
        this.#adoptionFailedChatIds.delete(chatId);
      } else {
        this.#fencedChatIds.delete(chatId);
        this.#adoptionFailedChatIds.add(chatId);
      }
      const code = searchFailureCode(error);
      const viewId = fenced
        ? LEDGER_FENCED_VIEW_SENTINEL
        : LEDGER_UNADOPTED_VIEW_SENTINEL;
      await this.#deps.service.markChatUnavailable(chatId, viewId, code)
        .catch((markError) => this.#warnIndexFailure(chatId, operation, markError));
      this.#warnIndexFailure(chatId, operation, error);
      return null;
    }
  }

  async #resyncAll(): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    const startedAt = performance.now();
    let states: ReadonlyMap<string, SearchChatState>;
    let chatIds: string[];
    try {
      states = new Map(
        (await this.#deps.service.chatStates()).map((state) => [state.chatId, state]),
      );
      chatIds = [...new Set(this.#deps.listChatIds())];
    } catch (error) {
      this.#deps.service.recordResyncFailure(resyncFailureCode(error));
      this.#warnCatalogFailure('synchronization', error);
      return;
    }
    const scope = this.#deps.service.beginResync(chatIds.length);
    let current = 0;
    let jobs = 0;
    let deletions = 0;
    let failures = 0;
    try {
      for (const chatId of chatIds) {
        if (!this.#enabled || this.#closed) return;
        try {
          const snapshot = await this.#catalogSnapshot(chatId, 'resync');
          const state = states.get(chatId) ?? null;
          if (!snapshot) {
            failures += 1;
            continue;
          }
          const { view, through } = snapshot;
          if (
            state
            && state.status === 'indexed'
            && state.transcriptViewId === view.viewId
            && state.indexedThrough >= through
          ) {
            this.#indexedViews.set(chatId, {
              viewId: view.viewId,
              through: state.indexedThrough,
            });
            current += 1;
            continue;
          }
          jobs += 1;
          await this.#enqueue(chatId, () => this.#syncCurrentChat(chatId))
            .catch((error) => this.#warnIndexFailure(chatId, 'resync', error));
        } finally {
          scope.chatSettled();
        }
      }
      const registry = new Set(chatIds);
      for (const staleChatId of states.keys()) {
        if (registry.has(staleChatId)) continue;
        this.#ledgerSnapshots.delete(staleChatId);
        this.#fencedChatIds.delete(staleChatId);
        deletions += 1;
        await this.#enqueue(staleChatId, () => this.#deps.service.deleteChat(staleChatId))
          .catch((error) => this.#warnIndexFailure(staleChatId, 'prune', error));
      }
      if (this.#enabled && !this.#closed) scope.complete();
    } catch (error) {
      scope.fail(resyncFailureCode(error));
      this.#warnCatalogFailure('synchronization', error);
      return;
    }
    this.#deps.logger.info('Transcript search resync complete', {
      code: 'SEARCH_RESYNC_COMPLETE',
      chats: chatIds.length,
      current,
      jobs,
      deletions,
      failures,
      wallMs: Math.round(performance.now() - startedAt),
    });
  }

  async #syncCurrentChat(chatId: string): Promise<void> {
    if (!this.#deps.hasChat(chatId)) {
      this.#forgetChat(chatId);
      return;
    }
    let view: TranscriptView | null;
    let through: number;
    try {
      view = this.#deps.ledger.existingCurrentView(chatId);
      through = view ? this.#deps.ledger.highWatermark(chatId).ordinal : 0;
      this.#fencedChatIds.delete(chatId);
      if (view) {
        this.#ledgerSnapshots.set(chatId, { viewId: view.viewId, through });
        this.#adoptionFailedChatIds.delete(chatId);
      }
      else this.#ledgerSnapshots.delete(chatId);
    } catch (error) {
      if (!(error instanceof LedgerFencedError)) throw error;
      this.#indexedViews.delete(chatId);
      this.#ledgerSnapshots.delete(chatId);
      this.#fencedChatIds.add(chatId);
      await this.#deps.service.markChatUnavailable(
        chatId,
        LEDGER_FENCED_VIEW_SENTINEL,
        fenceErrorCode(error),
      );
      return;
    }
    if (!view) {
      this.#indexedViews.delete(chatId);
      this.#ledgerSnapshots.delete(chatId);
      return;
    }
    const viewId = view.viewId;
    await this.#deps.service.syncChat({
      mode: 'replace',
      chatId,
      transcriptViewId: viewId,
      expectedAfterOrdinal: 0,
      targetThrough: through,
      source: (afterOrdinal) => this.#ledgerFrames(chatId, viewId, afterOrdinal, through),
    });
    if (!this.#deps.hasChat(chatId)) {
      this.#forgetChat(chatId);
      return;
    }
    this.#indexedViews.set(chatId, { viewId, through });
  }

  async *#ledgerFrames(
    chatId: string,
    viewId: TranscriptViewId,
    afterOrdinal: number,
    throughOrdinal: number,
  ): AsyncGenerator<TranscriptSearchSyncFrame, void, void> {
    let cursor = afterOrdinal;
    while (cursor < throughOrdinal) {
      let frame: TranscriptSearchSyncFrame;
      try {
        frame = await this.#ingestPacer.pay(() => {
          if (!this.#deps.hasChat(chatId)) throw new Error('SEARCH_VIEW_MISMATCH');
          const page = this.#deps.ledger.replayRows(
            chatId,
            viewId,
            cursor,
            throughOrdinal,
            LEDGER_PAGE_ROWS,
          );
          if (page.length === 0) throw new Error('SEARCH_INDEX_GAP');
          cursor = page[page.length - 1]!.ordinal;
          return {
            rows: searchableRows(page),
            advanceTo: Math.min(cursor, throughOrdinal),
          };
        });
      } catch (error) {
        if (error instanceof LedgerFencedError || error instanceof StaleTranscriptViewError) {
          throw new Error('SEARCH_VIEW_MISMATCH');
        }
        throw error;
      }
      yield frame;
    }
  }

  async #syncCatalogChat(chatId: string): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    if (!this.#deps.hasChat(chatId)) {
      this.#forgetChat(chatId);
      await this.#deps.service.deleteChat(chatId);
      return;
    }
    const snapshot = await this.#catalogSnapshot(chatId, 'catalog-refresh');
    if (!snapshot) return;
    const { view, through } = snapshot;
    const cached = this.#indexedViews.get(chatId);
    if (cached && cached.viewId === view.viewId && cached.through >= through) return;
    await this.#syncCurrentChat(chatId);
  }

  #onCommit(event: TranscriptCommitEvent): void {
    if (!this.#enabled || this.#closed) return;
    if (!this.#deps.hasChat(event.chatId)) {
      this.#forgetChat(event.chatId);
      return;
    }
    if (event.type === 'view-replaced') {
      this.#ledgerSnapshots.delete(event.chatId);
      this.#adoptionFailedChatIds.delete(event.chatId);
      this.#fencedChatIds.delete(event.chatId);
      this.#schedule(event.chatId, 'view-replacement', () => this.#syncCurrentChat(event.chatId));
      return;
    }
    const rows = rowsForCommit(event);
    if (rows.length === 0) return;
    this.#ledgerSnapshots.set(event.chatId, {
      viewId: event.viewId,
      through: rows.at(-1)!.ordinal,
    });
    this.#adoptionFailedChatIds.delete(event.chatId);
    this.#fencedChatIds.delete(event.chatId);
    this.#schedule(event.chatId, 'append', async () => {
      if (!this.#deps.hasChat(event.chatId)) {
        this.#forgetChat(event.chatId);
        return;
      }
      const first = rows[0]!.ordinal;
      const last = rows.at(-1)!.ordinal;
      try {
        await this.#deps.service.syncChat({
          mode: 'append',
          chatId: event.chatId,
          transcriptViewId: event.viewId,
          expectedAfterOrdinal: first - 1,
          targetThrough: last,
          source: async function* (afterOrdinal) {
            const fresh = rows.filter((row) => row.ordinal > afterOrdinal);
            yield { rows: searchableRows(fresh), advanceTo: last };
          },
        });
        if (!this.#deps.hasChat(event.chatId)) {
          this.#forgetChat(event.chatId);
          return;
        }
        this.#indexedViews.set(event.chatId, { viewId: event.viewId, through: last });
      } catch (error) {
        if (!isIndexPositionMismatch(error)) throw error;
        await this.#syncCurrentChat(event.chatId);
      }
    });
  }

  #schedule(chatId: string, operation: string, work: () => Promise<void>): void {
    void this.#enqueue(chatId, work).catch((error) => {
      this.#warnIndexFailure(chatId, operation, error);
    });
  }

  #warnIndexFailure(chatId: string, operation: string, error: unknown): void {
    this.#deps.logger.warn('Transcript search indexing job failed', {
      chatId,
      operation,
      code: searchFailureCode(error),
    });
  }

  #warnCatalogFailure(operation: string, error: unknown): void {
    this.#deps.logger.warn('Transcript search catalog job failed', {
      operation,
      code: resyncFailureCode(error),
    });
  }

  #enqueue(chatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#chatTails.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#chatTails.set(chatId, next);
    const removeTail = () => {
      if (this.#chatTails.get(chatId) === next) this.#chatTails.delete(chatId);
    };
    void next.then(removeTail, removeTail);
    return next;
  }

  #forgetChat(chatId: string): void {
    this.#indexedViews.delete(chatId);
    this.#ledgerSnapshots.delete(chatId);
    this.#adoptionFailedChatIds.delete(chatId);
    this.#adoptingChatIds.delete(chatId);
    this.#fencedChatIds.delete(chatId);
  }
}

function fenceErrorCode(error: LedgerFencedError): string {
  const code = safeFenceDiagnostic(error).causeCode;
  return code === 'UNKNOWN' ? 'LEDGER_FENCED' : code;
}

function resyncFailureCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)
    ? error.message
    : 'SEARCH_RESYNC_FAILED';
}

const INGEST_PACING_RATIO = 0.5;

class IngestPacer {
  #debtMs = 0;
  #tail: Promise<void> = Promise.resolve();

  pay<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.#tail.then(() => this.#pay(work));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #pay<T>(work: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      const busyMs = performance.now() - started;
      this.#debtMs += busyMs * (1 - INGEST_PACING_RATIO) / INGEST_PACING_RATIO;
      if (this.#debtMs >= 1) {
        const sleepMs = Math.floor(this.#debtMs);
        this.#debtMs -= sleepMs;
        await Bun.sleep(sleepMs);
      } else {
        await Bun.sleep(0);
      }
    }
  }
}

function translateSearchError(
  error: unknown,
  logger: Pick<AgentLogger, 'warn'>,
): TranscriptSearchUnavailableError {
  if (error instanceof TranscriptSearchUnavailableError) return error;
  const code = error instanceof Error ? error.message : '';
  if (code === 'SEARCH_TIMEOUT' || isAbortError(error)) {
    return new TranscriptSearchUnavailableError(
      'SEARCH_TIMEOUT',
      'Transcript search timed out',
      true,
    );
  }
  if (code === 'SEARCH_INDEX_BUSY') {
    return new TranscriptSearchUnavailableError(
      'SEARCH_INDEX_BUSY',
      'Transcript search is busy',
      true,
    );
  }
  logger.warn('Transcript search request failed', {
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'SEARCH_INTERNAL',
    errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
      ? error.name
      : 'UNKNOWN',
  });
  return new TranscriptSearchUnavailableError(
    'SEARCH_INDEX_UNAVAILABLE',
    'Transcript search is unavailable',
    true,
  );
}

function isIndexPositionMismatch(error: unknown): boolean {
  return error instanceof Error
    && (error.message === 'SEARCH_INDEX_GAP' || error.message === 'SEARCH_VIEW_MISMATCH');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function searchFailureCode(error: unknown): string {
  if (error instanceof LedgerFencedError) return fenceErrorCode(error);
  if (error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message)) {
    return error.message;
  }
  return 'SEARCH_INDEX_UNAVAILABLE';
}

function rowsForCommit(
  event: Exclude<TranscriptCommitEvent, { type: 'view-replaced' }>,
): readonly LedgerRow[] {
  return event.type === 'rows' ? event.rows : [event.row];
}

function searchableRows(rows: readonly LedgerRow[]): HistoricalSearchMessageRow[] {
  return rows.flatMap((row) => {
    const message = searchableMessage(row);
    if (!message) return [];
    const projected = projectSearchMessage(message);
    return projected ? [{ ordinal: row.ordinal, ...projected }] : [];
  });
}

function searchableMessage(row: LedgerRow): ChatMessage | null {
  switch (row.kind) {
    case 'user-input':
      return row.detail.message;
    case 'provider-row':
      return row.message;
    default:
      return null;
  }
}

function compileQuery(query: string, textTokens?: readonly string[]): ChatSearchQueryV1 {
  const quoted = new Map<string, number>();
  for (const match of query.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const value = (match[1] ?? match[2] ?? '').toLowerCase();
    quoted.set(value, (quoted.get(value) ?? 0) + 1);
  }
  const raw = textTokens?.length
    ? textTokens.map((text) => {
      const key = text.toLowerCase();
      const count = quoted.get(key) ?? 0;
      if (count > 0) quoted.set(key, count - 1);
      return { text, phrase: /\s/u.test(text) || count > 0 };
    })
    : [...query.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)].map((match) => ({
      text: match[1] ?? match[2] ?? match[3] ?? '',
      phrase: match[1] !== undefined || match[2] !== undefined,
    }));
  return {
    version: 1,
    clauses: raw.map((term) => ({
      kind: term.phrase ? 'phrase' as const : 'all-words' as const,
      tokens: (term.text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((text) => ({
        text,
        normalized: text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase(),
        match: !term.phrase && [...text].length >= CHAT_SEARCH_MIN_PREFIX_CHARS
          ? 'prefix' as const
          : 'exact' as const,
      })),
    })).filter((clause) => clause.tokens.length > 0),
  };
}

function clampLimit(limit: number | undefined, mode: ChatSearchResultMode): number {
  const maximum = mode === 'prefix' ? CHAT_SEARCH_MAX_PREFIX_SIZE : CHAT_SEARCH_MAX_PAGE_SIZE;
  return Number.isInteger(limit)
    ? Math.min(maximum, Math.max(1, Number(limit)))
    : CHAT_SEARCH_DEFAULT_PAGE_SIZE;
}

function clampSnippetLimit(snippetLimit: number | undefined): number {
  return Number.isInteger(snippetLimit)
    ? Math.min(CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT, Math.max(1, Number(snippetLimit)))
    : CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT;
}

function clampOffset(offset: number | undefined): number {
  return Number.isInteger(offset)
    ? Math.min(CHAT_SEARCH_MAX_OFFSET, Math.max(0, Number(offset)))
    : 0;
}
