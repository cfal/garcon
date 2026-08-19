import type { Database } from 'bun:sqlite';
import type {
  ChatSearchClauseV1,
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  ChatSearchTokenV1,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
} from '@garcon/common/chat-search';
import {
  SEARCH_QUERY_MAX_NATIVE_TOKENS,
  SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES,
  SearchTokenizer,
} from './tokenizer.js';

export { SEARCH_QUERY_MAX_NATIVE_TOKENS, SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES };
export const SEARCH_READER_MAX_SQL_ROWS = 256;
export const SEARCH_READER_MAX_TERM_POSITION_BYTES = 512 * 1024;
export const SEARCH_READER_MAX_POSITION_OPERATIONS = 4_096;
export const SEARCH_READER_MAX_BODY_ROWS = 16;
export const SEARCH_READER_MAX_BODY_BYTES = 1024 * 1024;

export const DEFAULT_RESULT_LIMIT = 20;
export const MAX_RESULT_LIMIT = 100;
export const SNIPPETS_PER_CHAT = 3;
export const MAX_SNIPPET_CHARS = 512;
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

export interface CompiledPhrase {
  readonly key: string;
  readonly terms: readonly Buffer[];
  readonly prefix: boolean;
}

export interface CompiledClause {
  readonly phrases: readonly CompiledPhrase[];
}

export interface CompiledTranscriptSearchQuery {
  readonly clauses: readonly CompiledClause[];
  readonly uniquePhrases: readonly CompiledPhrase[];
}

export interface ActiveChunk {
  readonly id: number;
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly ordinal: number;
  readonly role: number;
  readonly timestamp: string | null;
  readonly tokenCount: number;
}

export interface StoredTermRow {
  readonly chatId: string;
  readonly term: Uint8Array;
  readonly frequency: number;
  readonly positions: Uint8Array;
}

export interface ExactDriverRow extends ActiveChunk {
  readonly termChatId: string;
  readonly term: Uint8Array;
  readonly frequency: number;
  readonly positions: Uint8Array;
}

export interface ExactDriverMatch {
  readonly chunk: ActiveChunk;
  readonly posting: StoredTermRow;
}

export interface AllowedStateRow {
  readonly chatId: string;
  readonly transcriptViewId: string;
  readonly throughOrdinal: number;
  readonly stateTranscriptViewId: string | null;
  readonly status: string | null;
  readonly phase: string | null;
  readonly targetThrough: number | null;
  readonly processedThrough: number | null;
}

export interface CorpusStatsRow {
  readonly documentCount: number;
  readonly totalTokenCount: number;
}

export interface PhraseMatch {
  readonly frequency: number;
}

export interface Winner {
  readonly allowed: TranscriptSearchAllowedChat;
  readonly score: number;
}

export interface SnippetIdentity {
  readonly chunk: ActiveChunk;
  readonly score: number;
}

export interface SliceCost {
  readonly sqlRows?: number;
  readonly termPositionBytes?: number;
  readonly positionOperations?: number;
  readonly bodyRows?: number;
  readonly bodyBytes?: number;
}

export interface ReaderSliceMetrics {
  readonly sqlRows: number;
  readonly termPositionBytes: number;
  readonly positionOperations: number;
  readonly bodyRows: number;
  readonly bodyBytes: number;
}

export type TranscriptSearchReaderStep =
  | { readonly type: 'continue'; readonly metrics: ReaderSliceMetrics }
  | {
      readonly type: 'complete';
      readonly metrics: ReaderSliceMetrics;
      readonly result: { readonly results: readonly ChatSearchResult[]; readonly index: ChatSearchIndexStatus };
    };

export class TranscriptSearchCorruptionError extends Error {
  constructor() {
    super('SEARCH_INDEX_CORRUPT');
    this.name = 'TranscriptSearchCorruptionError';
  }
}
export function corruption(): never {
  throw new TranscriptSearchCorruptionError();
}

export function emptyMetrics(cost: SliceCost = {}): ReaderSliceMetrics {
  return {
    sqlRows: cost.sqlRows ?? 0,
    termPositionBytes: cost.termPositionBytes ?? 0,
    positionOperations: cost.positionOperations ?? 0,
    bodyRows: cost.bodyRows ?? 0,
    bodyBytes: cost.bodyBytes ?? 0,
  };
}

export function assertSliceMetrics(metrics: ReaderSliceMetrics): void {
  if (metrics.sqlRows > SEARCH_READER_MAX_SQL_ROWS
      || metrics.termPositionBytes > SEARCH_READER_MAX_TERM_POSITION_BYTES
      || metrics.positionOperations > SEARCH_READER_MAX_POSITION_OPERATIONS
      || metrics.bodyRows > SEARCH_READER_MAX_BODY_ROWS
      || metrics.bodyBytes > SEARCH_READER_MAX_BODY_BYTES) {
    corruption();
  }
}

export function normalizePublicToken(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function validatePublicQuery(query: ChatSearchQueryV1): void {
  if (query.version !== 1 || !Array.isArray(query.clauses)
      || query.clauses.length > CHAT_SEARCH_MAX_TERMS) {
    throw new RangeError('INVALID_SEARCH_QUERY');
  }
  let wordCount = 0;
  for (const clause of query.clauses) {
    if ((clause.kind !== 'phrase' && clause.kind !== 'all-words')
        || !Array.isArray(clause.tokens) || clause.tokens.length === 0) {
      throw new RangeError('INVALID_SEARCH_QUERY');
    }
    wordCount += clause.tokens.length;
    if (wordCount > CHAT_SEARCH_MAX_WORDS) throw new RangeError('INVALID_SEARCH_QUERY');
    for (const token of clause.tokens) {
      if (typeof token.text !== 'string' || token.text.length === 0
          || normalizePublicToken(token.text) !== token.normalized
          || (token.match !== 'exact' && token.match !== 'prefix')
          || (clause.kind === 'phrase' && token.match !== 'exact')) {
        throw new RangeError('INVALID_SEARCH_QUERY');
      }
    }
  }
}

function phraseKey(terms: readonly Buffer[], prefix: boolean): string {
  return `${prefix ? 'p' : 'e'}:${terms.map((term) => term.toString('hex')).join('.')}`;
}

function compilePhrase(
  tokenizer: Pick<SearchTokenizer, 'tokenizeQuery'>,
  text: string,
  prefix: boolean,
  totals: { nativeTokens: number; normalizedBytes: number },
): CompiledPhrase {
  const native = tokenizer.tokenizeQuery(text);
  if (native.length === 0) throw new RangeError('INVALID_SEARCH_QUERY');
  const terms = native.map((token, index) => {
    if (!Number.isSafeInteger(token.position) || token.position !== index
        || !(token.term instanceof Uint8Array) || token.term.byteLength === 0
        || token.term.byteLength > 32_768) {
      throw new RangeError('INVALID_SEARCH_QUERY');
    }
    const term = Buffer.from(token.term);
    totals.nativeTokens += 1;
    totals.normalizedBytes += term.byteLength;
    if (totals.nativeTokens > SEARCH_QUERY_MAX_NATIVE_TOKENS
        || totals.normalizedBytes > SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES) {
      throw new RangeError('INVALID_SEARCH_QUERY');
    }
    return term;
  });
  return { key: phraseKey(terms, prefix), terms, prefix };
}

function compileClause(
  tokenizer: Pick<SearchTokenizer, 'tokenizeQuery'>,
  clause: ChatSearchClauseV1,
  totals: { nativeTokens: number; normalizedBytes: number },
): CompiledClause {
  if (clause.kind === 'phrase') {
    return {
      phrases: [compilePhrase(
        tokenizer,
        clause.tokens.map((token) => token.text).join(' '),
        false,
        totals,
      )],
    };
  }
  return {
    phrases: clause.tokens.map((token: ChatSearchTokenV1) => compilePhrase(
      tokenizer,
      token.text,
      token.match === 'prefix',
      totals,
    )),
  };
}

export function compileTranscriptSearchQueryV1(
  tokenizer: Pick<SearchTokenizer, 'tokenizeQuery'>,
  query: ChatSearchQueryV1,
): CompiledTranscriptSearchQuery {
  validatePublicQuery(query);
  const totals = { nativeTokens: 0, normalizedBytes: 0 };
  const clauses = query.clauses.map((clause) => compileClause(tokenizer, clause, totals));
  const unique = new Map<string, CompiledPhrase>();
  for (const clause of clauses) {
    for (const phrase of clause.phrases) unique.set(phrase.key, phrase);
  }
  return { clauses, uniquePhrases: [...unique.values()] };
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function validateAllowed(entry: TranscriptSearchAllowedChat): void {
  if (typeof entry.chatId !== 'string' || entry.chatId.length === 0
      || typeof entry.transcriptViewId !== 'string' || entry.transcriptViewId.length === 0
      || !wellFormedUtf16(entry.chatId) || !wellFormedUtf16(entry.transcriptViewId)
      || Buffer.byteLength(entry.chatId) > 256 || Buffer.byteLength(entry.transcriptViewId) > 256
      || !Number.isSafeInteger(entry.throughOrdinal) || entry.throughOrdinal < 0) {
    throw new RangeError('INVALID_SEARCH_REQUEST');
  }
}

function pragmaNumber(db: Database, sql: string, key: string): number {
  return Number(db.query<Record<string, number>, []>(sql).get()?.[key]);
}

export class TranscriptSearchAllowlist {
  readonly #db: Database;
  #closed = false;
  #sealed = false;
  #size = 0;

  constructor(db: Database) {
    this.#db = db;
    db.exec('PRAGMA temp_store = MEMORY');
    if (pragmaNumber(db, 'PRAGMA temp_store', 'temp_store') !== 2) {
      throw new Error('SEARCH_DATABASE_CONFIGURATION');
    }
    this.#withTempWrites(() => db.exec(`
      CREATE TEMP TABLE search_query_allowlist (
        chat_id TEXT PRIMARY KEY
          CHECK(length(CAST(chat_id AS BLOB)) BETWEEN 1 AND 256),
        transcript_view_id TEXT NOT NULL
          CHECK(length(CAST(transcript_view_id AS BLOB)) BETWEEN 1 AND 256),
        through_ordinal INTEGER NOT NULL CHECK(through_ordinal >= 0)
      ) STRICT
    `));
  }

  get size(): number {
    return this.#size;
  }

  append(entries: readonly TranscriptSearchAllowedChat[]): void {
    if (this.#closed || this.#sealed) throw new Error('INVALID_SEARCH_FRAME');
    const seen = new Set<string>();
    for (const entry of entries) {
      validateAllowed(entry);
      if (seen.has(entry.chatId)) throw new RangeError('INVALID_SEARCH_REQUEST');
      seen.add(entry.chatId);
    }
    this.#withTempWrites(() => {
      const insert = this.#db.prepare<{ chatId: string }, [string, string, number]>(`
        INSERT INTO temp.search_query_allowlist(chat_id, transcript_view_id, through_ordinal)
        VALUES (?, ?, ?) ON CONFLICT(chat_id) DO NOTHING RETURNING chat_id AS chatId
      `);
      this.#db.exec('SAVEPOINT search_allowlist_frame');
      try {
        for (const entry of entries) {
          if (!insert.get(entry.chatId, entry.transcriptViewId, entry.throughOrdinal)) {
            throw new RangeError('INVALID_SEARCH_REQUEST');
          }
        }
        this.#db.exec('RELEASE search_allowlist_frame');
      } catch (error) {
        this.#db.exec('ROLLBACK TO search_allowlist_frame');
        this.#db.exec('RELEASE search_allowlist_frame');
        throw error;
      } finally {
        insert.finalize();
      }
    });
    this.#size += entries.length;
  }

  seal(): void {
    if (this.#closed || this.#sealed) throw new Error('INVALID_SEARCH_FRAME');
    this.#sealed = true;
  }

  close(): void {
    if (this.#closed) return;
    this.#withTempWrites(() => this.#db.exec('DROP TABLE temp.search_query_allowlist'));
    this.#closed = true;
  }

  #withTempWrites(operation: () => void): void {
    const queryOnly = pragmaNumber(this.#db, 'PRAGMA query_only', 'query_only');
    if (queryOnly !== 0 && queryOnly !== 1) throw new Error('SEARCH_DATABASE_CONFIGURATION');
    if (queryOnly === 1) this.#db.exec('PRAGMA query_only = OFF');
    try {
      operation();
    } finally {
      if (queryOnly === 1) this.#db.exec('PRAGMA query_only = ON');
    }
    if (pragmaNumber(this.#db, 'PRAGMA query_only', 'query_only') !== queryOnly) {
      throw new Error('SEARCH_DATABASE_CONFIGURATION');
    }
  }
}
