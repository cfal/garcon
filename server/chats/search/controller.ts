import type { ChatSearchIndexStatus, ChatSearchQueryV1, ChatSearchResult } from '@garcon/common/chat-search';
import { CHAT_SEARCH_MIN_PREFIX_CHARS } from '@garcon/common/chat-search';
import { projectSearchMessage } from '@garcon/server-agent-common/search/message-projector';
import type { TranscriptSearchService } from '@garcon/server-agent-common/search/transcript-search-service';
import type {
  LedgerRow,
  TranscriptViewId,
} from '../../ledger/contracts.js';
import type {
  TranscriptCommitEvent,
  TranscriptLedgerService,
} from '../../ledger/service.js';
import { TranscriptSearchUnavailableError } from './errors.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;

export interface TranscriptSearchControllerDeps {
  readonly listChatIds: () => readonly string[];
  readonly ledger: Pick<
    TranscriptLedgerService,
    'currentView' | 'currentRows' | 'subscribe'
  >;
  readonly service: TranscriptSearchService;
  readonly searchTimeoutMs?: number;
}

export class TranscriptSearchController {
  readonly #deps: TranscriptSearchControllerDeps;
  readonly #lifecycleAbort = new AbortController();
  readonly #chatTails = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  #enabled = false;
  #admissionFailed = false;
  #closed = false;

  constructor(deps: TranscriptSearchControllerDeps) {
    this.#deps = deps;
    this.#unsubscribe = deps.ledger.subscribe((event) => this.#onCommit(event));
    deps.service.setResyncHandler(() => this.#syncAll());
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
      this.#enabled = true;
      this.#admissionFailed = false;
      await this.#syncAll();
    } catch (error) {
      this.#enabled = false;
      this.#admissionFailed = true;
      throw error;
    }
  }

  sourceMayHaveChanged(chatId: string): void {
    this.catalogMayHaveChanged(chatId);
  }

  markDirty(chatId: string): void {
    this.catalogMayHaveChanged(chatId);
  }

  catalogMayHaveChanged(chatId?: string): void {
    if (!this.#enabled || this.#closed) return;
    if (chatId) {
      void this.#enqueue(chatId, () => this.#syncChat(chatId));
      return;
    }
    void this.#syncAll();
  }

  deleteChat(chatId: string): void {
    if (!this.#enabled || this.#closed) return;
    void this.#enqueue(chatId, () => this.#deps.service.deleteChat(chatId));
  }

  async search(options: {
    readonly query: string;
    readonly textTokens?: string[];
    readonly allowedChatIds: string[];
    readonly limit?: number;
  }): Promise<{ results: ChatSearchResult[]; index: ChatSearchIndexStatus }> {
    if (!this.#enabled) {
      throw new TranscriptSearchUnavailableError(
        this.#admissionFailed ? 'SEARCH_INDEX_UNAVAILABLE' : 'TRANSCRIPT_SEARCH_DISABLED',
        this.#admissionFailed ? 'Transcript search is unavailable' : 'Transcript search is disabled',
        this.#admissionFailed,
      );
    }
    if (this.#closed) {
      throw new TranscriptSearchUnavailableError(
        'SEARCH_INDEX_UNAVAILABLE',
        'Transcript search is unavailable',
        true,
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
      for (const chatId of options.allowedChatIds) {
        const view = this.#deps.ledger.currentView(chatId);
        if (view) allowedViews.set(chatId, view.viewId);
      }
      const response = await this.#deps.service.search({
        query: compileQuery(options.query, options.textTokens),
        allowedChats: [...allowedViews].map(([chatId, transcriptViewId]) => ({
          chatId,
          transcriptViewId,
        })),
        limit: clampLimit(options.limit),
        signal: abort.signal,
      });
      return {
        results: response.results.filter(
          (result) => allowedViews.get(result.chatId) === result.transcriptViewId,
        ),
        index: response.index,
      };
    } catch {
      throw new TranscriptSearchUnavailableError(
        abort.signal.aborted ? 'SEARCH_INDEX_BUSY' : 'SEARCH_INDEX_UNAVAILABLE',
        abort.signal.aborted ? 'Transcript search is busy' : 'Transcript search is unavailable',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  validateResultView(chatId: string, transcriptViewId: string): boolean {
    return this.#enabled
      && !this.#closed
      && this.#deps.ledger.currentView(chatId)?.viewId === transcriptViewId;
  }

  async disableAndDelete(): Promise<void> {
    this.#enabled = false;
    this.#admissionFailed = false;
    await Promise.allSettled(this.#chatTails.values());
    this.#chatTails.clear();
    await this.#deps.service.disableAndDelete(new AbortController().signal);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#enabled = false;
    this.#lifecycleAbort.abort();
    this.#unsubscribe();
    await Promise.allSettled(this.#chatTails.values());
    this.#chatTails.clear();
    await this.#deps.service.close();
  }

  async #syncAll(): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    const chatIds = [...new Set(this.#deps.listChatIds())];
    await Promise.all(chatIds.map((chatId) => this.#enqueue(chatId, () => this.#syncChat(chatId))));
    await this.#deps.service.pruneChats(chatIds);
  }

  async #syncChat(chatId: string): Promise<void> {
    if (!this.#enabled || this.#closed) return;
    if (!this.#deps.listChatIds().includes(chatId)) {
      await this.#deps.service.deleteChat(chatId);
      return;
    }
    const view = this.#deps.ledger.currentView(chatId);
    if (!view) return;
    const rows = this.#deps.ledger.currentRows(chatId);
    await this.#deps.service.replaceChat({
      chatId,
      transcriptViewId: view.viewId,
      throughOrdinal: rows.at(-1)?.ordinal ?? 0,
      rows: searchableRows(rows),
    });
  }

  #onCommit(event: TranscriptCommitEvent): void {
    if (!this.#enabled || this.#closed) return;
    if (event.type === 'view-replaced') {
      void this.#enqueue(event.chatId, () => this.#syncChat(event.chatId));
      return;
    }
    const rows = rowsForCommit(event);
    if (rows.length === 0) return;
    void this.#enqueue(event.chatId, async () => {
      try {
        await this.#deps.service.appendRows({
          chatId: event.chatId,
          transcriptViewId: event.viewId,
          expectedAfterOrdinal: rows[0]!.ordinal - 1,
          throughOrdinal: rows.at(-1)!.ordinal,
          rows: searchableRows(rows),
        });
      } catch {
        await this.#syncChat(event.chatId);
      }
    });
  }

  #enqueue(chatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#chatTails.get(chatId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#chatTails.set(chatId, next);
    void next.finally(() => {
      if (this.#chatTails.get(chatId) === next) this.#chatTails.delete(chatId);
    });
    return next;
  }
}

function rowsForCommit(event: Exclude<TranscriptCommitEvent, { type: 'view-replaced' }>): readonly LedgerRow[] {
  return event.type === 'rows' ? event.rows : [event.row];
}

function searchableRows(rows: readonly LedgerRow[]) {
  return rows.flatMap((row) => {
    const message = row.kind === 'user-input'
      ? row.detail.message
      : row.kind === 'provider-row'
        ? row.message
        : null;
    if (!message) return [];
    const projected = projectSearchMessage(message);
    return projected ? [{ ordinal: row.ordinal, ...projected }] : [];
  });
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
  return Number.isInteger(limit) ? Math.min(MAX_LIMIT, Math.max(1, Number(limit))) : DEFAULT_LIMIT;
}
