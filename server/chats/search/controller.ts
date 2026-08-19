import {
  CHAT_SEARCH_MIN_PREFIX_CHARS,
  type ChatSearchIndexStatus,
  type ChatSearchQueryV1,
  type ChatSearchResult,
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
import { TranscriptSearchUnavailableError } from './errors.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;
const LEDGER_PAGE_ROWS = 512;
const LEDGER_FENCED_VIEW_SENTINEL: TranscriptViewId = transcriptViewId('ledger-fenced');

export interface TranscriptSearchControllerDeps {
  readonly listChatIds: () => readonly string[];
  readonly ledger: Pick<
    TranscriptLedgerService,
    'currentView' | 'highWatermark' | 'replayRows' | 'subscribe'
  >;
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
  readonly #fencedChatIds = new Set<string>();
  readonly #unsubscribe: () => void;
  #resyncTail: Promise<void> = Promise.resolve();
  #enabled = false;
  #admissionFailed = false;
  #closed = false;

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
    try {
      await this.#deps.service.enable(this.#lifecycleAbort.signal);
    } catch (error) {
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
    if (!this.#enabled || this.#closed) return;
    this.#schedule(chatId, 'catalog-refresh', () => this.#syncCatalogChat(chatId));
  }

  deleteChat(chatId: string): void {
    this.#indexedViews.delete(chatId);
    this.#ledgerSnapshots.delete(chatId);
    this.#fencedChatIds.delete(chatId);
    if (!this.#enabled || this.#closed) return;
    this.#schedule(chatId, 'delete', () => this.#deps.service.deleteChat(chatId));
  }

  async search(options: {
    readonly query: string;
    readonly textTokens?: string[];
    readonly allowedChatIds: string[];
    readonly limit?: number;
  }): Promise<{ results: ChatSearchResult[]; index: ChatSearchIndexStatus }> {
    if (!this.#enabled || this.#closed) {
      const unavailable = this.#admissionFailed || this.#closed;
      throw new TranscriptSearchUnavailableError(
        unavailable ? 'SEARCH_INDEX_UNAVAILABLE' : 'TRANSCRIPT_SEARCH_DISABLED',
        unavailable ? 'Transcript search is unavailable' : 'Transcript search is disabled',
        unavailable,
      );
    }
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(),
      this.#deps.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
    );
    timeout.unref?.();
    try {
      const allowedViews = new Map<string, TranscriptViewId>();
      const allowedChats: TranscriptSearchAllowedChat[] = [];
      const fencedChatIds = new Set<string>();
      for (const chatId of options.allowedChatIds) {
        const snapshot = this.#ledgerSnapshot(chatId);
        if (!snapshot) {
          if (this.#fencedChatIds.has(chatId)) fencedChatIds.add(chatId);
          continue;
        }
        allowedViews.set(chatId, snapshot.viewId);
        allowedChats.push({
          chatId,
          transcriptViewId: snapshot.viewId,
          throughOrdinal: snapshot.through,
        });
      }
      const response = await this.#deps.service.search({
        query: compileQuery(options.query, options.textTokens),
        allowedChats,
        limit: clampLimit(options.limit),
        signal: abort.signal,
      });
      return {
        results: response.results.filter((result) => (
          allowedViews.get(result.chatId) === result.transcriptViewId
          && this.validateResultView(result.chatId, result.transcriptViewId)
        )),
        index: {
          ...response.index,
          failedChatCount: response.index.failedChatCount + fencedChatIds.size,
        },
      };
    } catch (error) {
      throw translateSearchError(error, this.#deps.logger);
    } finally {
      clearTimeout(timeout);
    }
  }

  #ledgerSnapshot(chatId: string): { viewId: TranscriptViewId; through: number } | null {
    const cached = this.#ledgerSnapshots.get(chatId);
    if (cached) return cached;
    if (this.#fencedChatIds.has(chatId)) return null;
    try {
      const view = this.#deps.ledger.currentView(chatId);
      if (!view) return null;
      const watermark = this.#deps.ledger.highWatermark(chatId);
      if (watermark.viewId !== view.viewId) return null;
      const snapshot = { viewId: view.viewId, through: watermark.ordinal };
      this.#ledgerSnapshots.set(chatId, snapshot);
      return snapshot;
    } catch (error) {
      if (!(error instanceof LedgerFencedError)) throw error;
      this.#fencedChatIds.add(chatId);
      return null;
    }
  }

  validateResultView(chatId: string, transcriptViewId: string): boolean {
    if (!this.#enabled || this.#closed) return false;
    try {
      return this.#deps.ledger.currentView(chatId)?.viewId === transcriptViewId;
    } catch (error) {
      if (!(error instanceof LedgerFencedError)) throw error;
      return false;
    }
  }

  async disableAndDelete(): Promise<void> {
    this.#enabled = false;
    this.#admissionFailed = false;
    await Promise.allSettled(this.#chatTails.values());
    this.#chatTails.clear();
    this.#indexedViews.clear();
    this.#ledgerSnapshots.clear();
    this.#fencedChatIds.clear();
    await this.#deps.service.disableAndDelete(new AbortController().signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#lifecycleAbort.abort();
    this.#unsubscribe();
    await this.#resyncTail.catch(() => undefined);
    await Promise.allSettled(this.#chatTails.values());
    this.#chatTails.clear();
    this.#indexedViews.clear();
    this.#ledgerSnapshots.clear();
    this.#fencedChatIds.clear();
    await this.#deps.service.close();
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
          let view: TranscriptView | null;
          let through: number;
          try {
            const probe = await this.#ingestPacer.pay(() => {
              const currentView = this.#deps.ledger.currentView(chatId);
              return {
                view: currentView,
                through: currentView ? this.#deps.ledger.highWatermark(chatId).ordinal : 0,
              };
            });
            view = probe.view;
            through = probe.through;
            this.#fencedChatIds.delete(chatId);
            if (view) this.#ledgerSnapshots.set(chatId, { viewId: view.viewId, through });
            else this.#ledgerSnapshots.delete(chatId);
          } catch (error) {
            if (!(error instanceof LedgerFencedError)) throw error;
            this.#ledgerSnapshots.delete(chatId);
            this.#fencedChatIds.add(chatId);
            failures += 1;
            await this.#enqueue(chatId, () => this.#deps.service.markChatUnavailable(
              chatId,
              LEDGER_FENCED_VIEW_SENTINEL,
              fenceErrorCode(error),
            )).catch((markError) => this.#warnIndexFailure(chatId, 'resync', markError));
            this.#warnIndexFailure(chatId, 'resync', error);
            continue;
          }
          const state = states.get(chatId) ?? null;
          if (!view) {
            if (state) {
              deletions += 1;
              await this.#enqueue(chatId, () => this.#deps.service.deleteChat(chatId))
                .catch((error) => this.#warnIndexFailure(chatId, 'resync', error));
            }
            continue;
          }
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
    let view: TranscriptView | null;
    let through: number;
    try {
      view = this.#deps.ledger.currentView(chatId);
      through = view ? this.#deps.ledger.highWatermark(chatId).ordinal : 0;
      this.#fencedChatIds.delete(chatId);
      if (view) this.#ledgerSnapshots.set(chatId, { viewId: view.viewId, through });
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
    let view: TranscriptView | null;
    let through = 0;
    try {
      view = this.#deps.ledger.currentView(chatId);
      through = view ? this.#deps.ledger.highWatermark(chatId).ordinal : 0;
      this.#fencedChatIds.delete(chatId);
      if (view) this.#ledgerSnapshots.set(chatId, { viewId: view.viewId, through });
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
      this.#ledgerSnapshots.delete(chatId);
      if (this.#indexedViews.delete(chatId)) await this.#deps.service.deleteChat(chatId);
      return;
    }
    const cached = this.#indexedViews.get(chatId);
    if (cached && cached.viewId === view.viewId && cached.through >= through) return;
    if (!this.#deps.listChatIds().includes(chatId)) {
      this.#indexedViews.delete(chatId);
      this.#ledgerSnapshots.delete(chatId);
      this.#fencedChatIds.delete(chatId);
      await this.#deps.service.deleteChat(chatId);
      return;
    }
    await this.#syncCurrentChat(chatId);
  }

  #onCommit(event: TranscriptCommitEvent): void {
    if (!this.#enabled || this.#closed) return;
    if (event.type === 'view-replaced') {
      this.#ledgerSnapshots.delete(event.chatId);
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
    this.#fencedChatIds.delete(event.chatId);
    this.#schedule(event.chatId, 'append', async () => {
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

  async pay<T>(work: () => T): Promise<T> {
    const started = performance.now();
    try {
      return work();
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
  if (code === 'SEARCH_TIMEOUT' || (error instanceof DOMException && error.name === 'AbortError')) {
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

function searchFailureCode(error: unknown): string {
  if (error instanceof LedgerFencedError) return fenceErrorCode(error);
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

function clampLimit(limit: number | undefined): number {
  return Number.isInteger(limit)
    ? Math.min(MAX_LIMIT, Math.max(1, Number(limit)))
    : DEFAULT_LIMIT;
}
