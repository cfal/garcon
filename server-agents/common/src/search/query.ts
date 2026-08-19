import type { Database } from 'bun:sqlite';
import type {
  ChatSearchIndexStatus,
  ChatSearchQueryV1,
  ChatSearchResult,
  ChatSearchSnippetRole,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  SearchTokenizer,
  compareSearchTerms,
} from './tokenizer.js';
import { SEARCH_ACTIVE_COMPLETE_PREDICATE } from './schema.js';
import {
  BM25_B,
  BM25_K1,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_SNIPPET_CHARS,
  SEARCH_READER_MAX_BODY_BYTES,
  SEARCH_READER_MAX_BODY_ROWS,
  SEARCH_READER_MAX_POSITION_OPERATIONS,
  SEARCH_READER_MAX_SQL_ROWS,
  SEARCH_READER_MAX_TERM_POSITION_BYTES,
  SNIPPETS_PER_CHAT,
  TranscriptSearchAllowlist,
  assertSliceMetrics,
  compileTranscriptSearchQueryV1,
  corruption,
  emptyMetrics,
  normalizePublicToken,
  type ActiveChunk,
  type AllowedStateRow,
  type CompiledPhrase,
  type CompiledTranscriptSearchQuery,
  type CorpusStatsRow,
  type ExactDriverMatch,
  type ExactDriverRow,
  type PhraseMatch,
  type ReaderSliceMetrics,
  type SliceCost,
  type SnippetIdentity,
  type StoredTermRow,
  type TranscriptSearchReaderStep,
  type Winner,
  validateAllowed,
} from './query-contract.js';

export {
  SEARCH_QUERY_MAX_NATIVE_TOKENS,
  SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES,
  SEARCH_READER_MAX_BODY_BYTES,
  SEARCH_READER_MAX_BODY_ROWS,
  SEARCH_READER_MAX_POSITION_OPERATIONS,
  SEARCH_READER_MAX_SQL_ROWS,
  SEARCH_READER_MAX_TERM_POSITION_BYTES,
  TranscriptSearchAllowlist,
  TranscriptSearchCorruptionError,
  compileTranscriptSearchQueryV1,
} from './query-contract.js';
export type {
  CompiledTranscriptSearchQuery,
  ReaderSliceMetrics,
  TranscriptSearchReaderStep,
} from './query-contract.js';

function clampLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit)) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.max(1, Number(limit)));
}

function roleName(role: number): ChatSearchSnippetRole {
  if (role === 0) return 'user';
  if (role === 1) return 'assistant';
  if (role === 2) return 'tool';
  if (role === 3) return 'system';
  return corruption();
}

function buffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  for (let index = 0; index < prefix.byteLength; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  return true;
}

function prefixUpperBound(prefix: Buffer): Buffer {
  const upper = Buffer.from(prefix);
  for (let index = upper.length - 1; index >= 0; index -= 1) {
    if (upper[index] === 0xff) continue;
    upper[index] += 1;
    return upper.subarray(0, index + 1);
  }
  return corruption();
}

function* decodePositions(
  encoded: Uint8Array,
  frequency: number,
  tokenCount: number,
): Generator<SliceCost, number[], void> {
  if (!(encoded instanceof Uint8Array) || encoded.byteLength === 0
      || !Number.isSafeInteger(frequency) || frequency < 1
      || !Number.isSafeInteger(tokenCount) || tokenCount < 1) {
    return corruption();
  }
  const positions: number[] = [];
  let offset = 0;
  let previous = -1;
  while (offset < encoded.byteLength) {
    let operations = 0;
    while (offset < encoded.byteLength && operations < SEARCH_READER_MAX_POSITION_OPERATIONS) {
      let delta = 0;
      let shift = 0;
      let groups = 0;
      let final = 0;
      while (true) {
        if (offset >= encoded.byteLength || shift > 49) return corruption();
        const byte = encoded[offset];
        offset += 1;
        groups += 1;
        final = byte & 0x7f;
        delta += final * (2 ** shift);
        if (!Number.isSafeInteger(delta)) return corruption();
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      if (delta === 0 || (groups > 1 && final === 0)) return corruption();
      const position = previous + delta;
      if (!Number.isSafeInteger(position) || position <= previous || position >= tokenCount - 1) {
        return corruption();
      }
      positions.push(position);
      if (positions.length > frequency || positions.length > tokenCount - 1) return corruption();
      previous = position;
      operations += 1;
    }
    yield { positionOperations: operations };
  }
  if (positions.length !== frequency) return corruption();
  return positions;
}

function exactTermRow(db: Database, chunk: ActiveChunk, term: Buffer): StoredTermRow | null {
  const row = db.query<StoredTermRow, [number, Uint8Array]>(`
    SELECT terms.chat_id AS chatId, terms.term, terms.frequency, terms.positions
    FROM search_chunk_terms terms
    JOIN search_chunks owner ON owner.id = terms.chunk_id
    WHERE terms.chunk_id = ? AND terms.term = ?
  `).get(chunk.id, term) ?? null;
  if (row && (row.chatId !== chunk.chatId || compareSearchTerms(row.term, term) !== 0)) corruption();
  return row;
}

function prefixTermRow(
  db: Database,
  chunk: ActiveChunk,
  prefix: Buffer,
  after: Buffer | null,
): StoredTermRow | null {
  const upper = prefixUpperBound(prefix);
  const row = after === null
    ? db.query<StoredTermRow, [number, Uint8Array, Uint8Array]>(`
      SELECT terms.chat_id AS chatId, terms.term, terms.frequency, terms.positions
      FROM search_chunk_terms terms
      JOIN search_chunks owner ON owner.id = terms.chunk_id
      WHERE terms.chunk_id = ? AND terms.term >= ? AND terms.term < ?
      ORDER BY terms.term LIMIT 1
    `).get(chunk.id, prefix, upper)
    : db.query<StoredTermRow, [number, Uint8Array, Uint8Array]>(`
      SELECT terms.chat_id AS chatId, terms.term, terms.frequency, terms.positions
      FROM search_chunk_terms terms
      JOIN search_chunks owner ON owner.id = terms.chunk_id
      WHERE terms.chunk_id = ? AND terms.term > ? AND terms.term < ?
      ORDER BY terms.term LIMIT 1
    `).get(chunk.id, after, upper);
  if (!row) return null;
  if (row.chatId !== chunk.chatId || !startsWith(row.term, prefix)
      || (after !== null && compareSearchTerms(row.term, after) <= 0)) corruption();
  return row;
}

function* phraseFrequency(
  db: Database,
  chunk: ActiveChunk,
  phrase: CompiledPhrase,
  driver: StoredTermRow | null = null,
): Generator<SliceCost, PhraseMatch | null, void> {
  const termPositions = new Map<string, number[]>();
  for (let index = 0; index < phrase.terms.length - (phrase.prefix ? 1 : 0); index += 1) {
    const term = phrase.terms[index];
    const key = term.toString('hex');
    if (termPositions.has(key)) continue;
    const usesDriver = driver !== null && compareSearchTerms(driver.term, term) === 0;
    const row = usesDriver ? driver : exactTermRow(db, chunk, term);
    const bytes = row ? row.term.byteLength + row.positions.byteLength : 0;
    if (bytes > SEARCH_READER_MAX_TERM_POSITION_BYTES) return corruption();
    if (!usesDriver) yield { sqlRows: 1, termPositionBytes: bytes };
    if (!row) return null;
    if (row.chatId !== chunk.chatId || compareSearchTerms(row.term, term) !== 0) corruption();
    termPositions.set(key, yield* decodePositions(row.positions, row.frequency, chunk.tokenCount));
  }

  let finalPositions: number[];
  if (phrase.prefix) {
    const prefix = phrase.terms[phrase.terms.length - 1];
    const collected: number[] = [];
    const collectedSet = new Set<number>();
    let after: Buffer | null = null;
    while (true) {
      const row = prefixTermRow(db, chunk, prefix, after);
      const bytes = row ? row.term.byteLength + row.positions.byteLength : 0;
      if (bytes > SEARCH_READER_MAX_TERM_POSITION_BYTES) return corruption();
      yield { sqlRows: 1, termPositionBytes: bytes };
      if (!row) break;
      const decoded = yield* decodePositions(row.positions, row.frequency, chunk.tokenCount);
      for (let start = 0; start < decoded.length; start += SEARCH_READER_MAX_POSITION_OPERATIONS) {
        const end = Math.min(decoded.length, start + SEARCH_READER_MAX_POSITION_OPERATIONS);
        for (let index = start; index < end; index += 1) {
          if (collectedSet.has(decoded[index])) return corruption();
          collectedSet.add(decoded[index]);
          collected.push(decoded[index]);
        }
        yield { positionOperations: end - start };
      }
      if (collected.length > chunk.tokenCount - 1) return corruption();
      after = buffer(row.term);
    }
    if (collected.length === 0) return null;
    finalPositions = collected;
  } else {
    const final = phrase.terms[phrase.terms.length - 1];
    const key = final.toString('hex');
    if (!termPositions.has(key)) {
      const row = exactTermRow(db, chunk, final);
      const bytes = row ? row.term.byteLength + row.positions.byteLength : 0;
      if (bytes > SEARCH_READER_MAX_TERM_POSITION_BYTES) return corruption();
      yield { sqlRows: 1, termPositionBytes: bytes };
      if (!row) return null;
      termPositions.set(key, yield* decodePositions(row.positions, row.frequency, chunk.tokenCount));
    }
    finalPositions = termPositions.get(key)!;
  }

  if (phrase.terms.length === 1) return { frequency: finalPositions.length };
  const first = termPositions.get(phrase.terms[0].toString('hex'))!;
  const setByKey = new Map<string, Set<number>>();
  const positionSets: Set<number>[] = [];
  let setReferenceOperations = 0;
  for (let index = 0; index < phrase.terms.length; index += 1) {
    const key = phrase.prefix && index === phrase.terms.length - 1
      ? `prefix:${phrase.key}`
      : phrase.terms[index].toString('hex');
    let positions = setByKey.get(key);
    if (!positions) {
      positions = new Set();
      const source = phrase.prefix && index === phrase.terms.length - 1
        ? finalPositions
        : termPositions.get(key)!;
      for (let start = 0; start < source.length; start += SEARCH_READER_MAX_POSITION_OPERATIONS) {
        const end = Math.min(source.length, start + SEARCH_READER_MAX_POSITION_OPERATIONS);
        for (let position = start; position < end; position += 1) positions.add(source[position]);
        yield { positionOperations: end - start };
      }
      setByKey.set(key, positions);
    }
    positionSets.push(positions);
    setReferenceOperations += 1;
    if (setReferenceOperations === SEARCH_READER_MAX_POSITION_OPERATIONS) {
      yield { positionOperations: setReferenceOperations };
      setReferenceOperations = 0;
    }
  }
  if (setReferenceOperations > 0) yield { positionOperations: setReferenceOperations };
  let frequency = 0;
  let cursor = 0;
  let phraseOffset = 1;
  let currentMatches = true;
  while (cursor < first.length) {
    let operations = 0;
    while (cursor < first.length && operations < SEARCH_READER_MAX_POSITION_OPERATIONS) {
      const start = first[cursor];
      while (phraseOffset < positionSets.length
          && operations < SEARCH_READER_MAX_POSITION_OPERATIONS) {
        operations += 1;
        if (!positionSets[phraseOffset].has(start + phraseOffset)) {
          currentMatches = false;
          break;
        }
        phraseOffset += 1;
      }
      if (!currentMatches || phraseOffset === positionSets.length) {
        if (currentMatches) frequency += 1;
        cursor += 1;
        phraseOffset = 1;
        currentMatches = true;
      }
    }
    yield { positionOperations: operations };
  }
  return frequency > 0 ? { frequency } : null;
}

function bm25(frequency: number, documentLength: number, averageLength: number, df: number, n: number): number {
  const idf = Math.max(Math.log((n - df + 0.5) / (df + 0.5)), 1e-6);
  const denominator = frequency + BM25_K1 * (
    1 - BM25_B + BM25_B * documentLength / averageLength
  );
  return idf * frequency * (BM25_K1 + 1) / denominator;
}

function validateActiveChunk(chunk: ActiveChunk): void {
  if (!Number.isSafeInteger(chunk.id) || chunk.id < 1
      || typeof chunk.chatId !== 'string' || chunk.chatId.length === 0
      || typeof chunk.transcriptViewId !== 'string' || chunk.transcriptViewId.length === 0
      || !Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 1
      || !Number.isSafeInteger(chunk.role) || chunk.role < 0 || chunk.role > 3
      || (chunk.timestamp !== null && typeof chunk.timestamp !== 'string')
      || !Number.isSafeInteger(chunk.tokenCount) || chunk.tokenCount < 1) {
    corruption();
  }
}

function exactDriverIterator(
  db: Database,
  term: Buffer,
): Generator<SliceCost | ExactDriverMatch, void, void> {
  function* iterate(): Generator<SliceCost | ExactDriverMatch, void, void> {
    let afterChatId = '';
    let afterChunkId = 0;
    while (true) {
      const row = db.query<ExactDriverRow, [Uint8Array, string, string, number]>(`
        SELECT chunks.id, chunks.chat_id AS chatId,
          chunks.transcript_view_id AS transcriptViewId, chunks.ordinal,
          chunks.role, chunks.timestamp, chunks.token_count AS tokenCount,
          terms.chat_id AS termChatId, terms.term, terms.frequency, terms.positions
        FROM search_chunk_terms terms INDEXED BY search_chunk_terms_by_term
        JOIN search_chunks chunks ON chunks.id = terms.chunk_id
        JOIN search_chunk_progress progress ON progress.chunk_id = chunks.id
        JOIN search_chat_state state ON state.chat_id = chunks.chat_id
        WHERE terms.term = ?
          AND ${SEARCH_ACTIVE_COMPLETE_PREDICATE}
          AND (terms.chat_id > ? OR (terms.chat_id = ? AND terms.chunk_id > ?))
        ORDER BY terms.chat_id, terms.chunk_id LIMIT 1
      `).get(term, afterChatId, afterChatId, afterChunkId) ?? null;
      const bytes = row ? row.term.byteLength + row.positions.byteLength : 0;
      if (bytes > SEARCH_READER_MAX_TERM_POSITION_BYTES) corruption();
      yield { sqlRows: 1, termPositionBytes: bytes };
      if (!row) return;
      validateActiveChunk(row);
      if (row.termChatId !== row.chatId || compareSearchTerms(row.term, term) !== 0
          || !Number.isSafeInteger(row.frequency) || row.frequency < 1) {
        corruption();
      }
      yield {
        chunk: row,
        posting: {
          chatId: row.termChatId,
          term: row.term,
          frequency: row.frequency,
          positions: row.positions,
        },
      };
      afterChatId = row.termChatId;
      afterChunkId = row.id;
    }
  }
  return iterate();
}

function activeChunksIterator(db: Database): Generator<SliceCost | ActiveChunk, void, void> {
  function* iterate(): Generator<SliceCost | ActiveChunk, void, void> {
    let afterChat = '';
    let afterView = '';
    let afterOrdinal = 0;
    while (true) {
      const rows = db.query<ActiveChunk, [string, string, number, number]>(`
        SELECT chunks.id, chunks.chat_id AS chatId,
          chunks.transcript_view_id AS transcriptViewId, chunks.ordinal,
          chunks.role, chunks.timestamp, chunks.token_count AS tokenCount
        FROM search_chunks chunks INDEXED BY sqlite_autoindex_search_chunks_1
        JOIN search_chunk_progress progress ON progress.chunk_id = chunks.id
        JOIN search_chat_state state ON state.chat_id = chunks.chat_id
        WHERE ${SEARCH_ACTIVE_COMPLETE_PREDICATE}
          AND (chunks.chat_id, chunks.transcript_view_id, chunks.ordinal) > (?, ?, ?)
        ORDER BY chunks.chat_id, chunks.transcript_view_id, chunks.ordinal LIMIT ?
      `).all(afterChat, afterView, afterOrdinal, SEARCH_READER_MAX_SQL_ROWS);
      yield { sqlRows: Math.max(1, rows.length) };
      if (rows.length === 0) return;
      for (const chunk of rows) {
        validateActiveChunk(chunk);
        yield chunk;
      }
      const last = rows[rows.length - 1];
      afterChat = last.chatId;
      afterView = last.transcriptViewId;
      afterOrdinal = last.ordinal;
    }
  }
  return iterate();
}

function isActiveChunk(value: SliceCost | ActiveChunk): value is ActiveChunk {
  return 'id' in value;
}

function isExactDriverMatch(
  value: SliceCost | ExactDriverMatch,
): value is ExactDriverMatch {
  return 'chunk' in value;
}

function* chunksForAllowed(
  db: Database,
  allowed: TranscriptSearchAllowedChat,
): Generator<SliceCost | ActiveChunk, void, void> {
  let afterOrdinal = 0;
  while (true) {
    const rows = db.query<ActiveChunk, [string, string, number, number]>(`
      SELECT chunks.id, chunks.chat_id AS chatId,
        chunks.transcript_view_id AS transcriptViewId, chunks.ordinal,
        chunks.role, chunks.timestamp, chunks.token_count AS tokenCount
      FROM search_chunks chunks INDEXED BY sqlite_autoindex_search_chunks_1
      JOIN search_chunk_progress progress ON progress.chunk_id = chunks.id
      JOIN search_chat_state state ON state.chat_id = chunks.chat_id
      WHERE ${SEARCH_ACTIVE_COMPLETE_PREDICATE}
        AND chunks.chat_id = ? AND chunks.transcript_view_id = ?
        AND chunks.ordinal <= ?
        AND chunks.ordinal > ?
      ORDER BY chunks.ordinal LIMIT 256
    `).all(
      allowed.chatId,
      allowed.transcriptViewId,
      allowed.throughOrdinal,
      afterOrdinal,
    );
    yield { sqlRows: Math.max(1, rows.length) };
    if (rows.length === 0) return;
    for (const chunk of rows) {
      validateActiveChunk(chunk);
      yield chunk;
    }
    const last = rows[rows.length - 1];
    afterOrdinal = last.ordinal;
  }
}

function* evaluateClauses(
  db: Database,
  chunk: ActiveChunk,
  compiled: CompiledTranscriptSearchQuery,
  df: ReadonlyMap<string, number>,
  stats: CorpusStatsRow,
): Generator<SliceCost, Array<number | null>, void> {
  const averageLength = stats.totalTokenCount / stats.documentCount;
  const scores: Array<number | null> = [];
  for (const clause of compiled.clauses) {
    let score = 0;
    let matched = true;
    for (const phrase of clause.phrases) {
      const phraseDf = df.get(phrase.key) ?? 0;
      if (phraseDf === 0) {
        matched = false;
        break;
      }
      const match = yield* phraseFrequency(db, chunk, phrase);
      if (!match) {
        matched = false;
        break;
      }
      score += bm25(match.frequency, chunk.tokenCount, averageLength, phraseDf, stats.documentCount);
      yield { positionOperations: 1 };
    }
    scores.push(matched ? score : null);
  }
  return scores;
}

function updateTopWinners(winners: Winner[], winner: Winner): void {
  winners.push(winner);
  winners.sort((left, right) =>
    right.score - left.score
    || Buffer.compare(Buffer.from(left.allowed.chatId), Buffer.from(right.allowed.chatId))
    || Buffer.compare(
      Buffer.from(left.allowed.transcriptViewId),
      Buffer.from(right.allowed.transcriptViewId),
    ));
  if (winners.length > MAX_RESULT_LIMIT) winners.pop();
}

function updateTopSnippets(snippets: SnippetIdentity[], candidate: SnippetIdentity): void {
  snippets.push(candidate);
  snippets.sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal);
  if (snippets.length > SNIPPETS_PER_CHAT) snippets.pop();
}

interface SnippetToken {
  readonly term: Buffer;
  readonly start: number;
  readonly end: number;
}

function* snippetTokens(body: string): Generator<SliceCost, SnippetToken[], void> {
  const tokens: SnippetToken[] = [];
  let operations = 0;
  for (const match of body.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    tokens.push({
      term: Buffer.from(normalizePublicToken(match[0])),
      start: match.index,
      end: match.index + match[0].length,
    });
    operations += 1;
    if (operations === SEARCH_READER_MAX_POSITION_OPERATIONS) {
      yield { positionOperations: operations };
      operations = 0;
    }
  }
  if (operations > 0) yield { positionOperations: operations };
  return tokens;
}

function termMatches(token: Buffer, term: Buffer, prefix: boolean): boolean {
  return prefix ? startsWith(token, term) : compareSearchTerms(token, term) === 0;
}

function* firstQueryMatch(
  tokens: readonly SnippetToken[],
  compiled: CompiledTranscriptSearchQuery,
): Generator<SliceCost, number, void> {
  let first = Number.POSITIVE_INFINITY;
  let operations = 0;
  for (const phrase of compiled.uniquePhrases) {
    for (let start = 0; start + phrase.terms.length <= tokens.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < phrase.terms.length; offset += 1) {
        operations += 1;
        if (!termMatches(
          tokens[start + offset].term,
          phrase.terms[offset],
          phrase.prefix && offset === phrase.terms.length - 1,
        )) {
          matched = false;
          break;
        }
        if (operations === SEARCH_READER_MAX_POSITION_OPERATIONS) {
          yield { positionOperations: operations };
          operations = 0;
        }
      }
      if (matched) {
        first = Math.min(first, start);
        break;
      }
      if (operations === SEARCH_READER_MAX_POSITION_OPERATIONS) {
        yield { positionOperations: operations };
        operations = 0;
      }
    }
  }
  if (operations > 0) yield { positionOperations: operations };
  return Number.isFinite(first) ? first : 0;
}

function snippetWindow(body: string, tokens: readonly SnippetToken[], match: number): string {
  if (tokens.length === 0) return '';
  const startToken = Math.max(0, match - 8);
  const endToken = Math.min(tokens.length, startToken + 32);
  const raw = body.slice(tokens[startToken].start, tokens[endToken - 1].end);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  const text = characters.slice(0, MAX_SNIPPET_CHARS).join('');
  const suffix = endToken < tokens.length || characters.length > MAX_SNIPPET_CHARS;
  return `${startToken > 0 ? '... ' : ''}${text}${suffix ? ' ...' : ''}`;
}

function allowedStatePage(
  db: Database,
  afterChatId: string | null,
): AllowedStateRow[] {
  const select = `
    SELECT allowed.chat_id AS chatId, allowed.transcript_view_id AS transcriptViewId,
      allowed.through_ordinal AS throughOrdinal,
      state.transcript_view_id AS stateTranscriptViewId, state.status, state.phase,
      state.target_through AS targetThrough, state.processed_through AS processedThrough
    FROM temp.search_query_allowlist allowed
      INDEXED BY sqlite_autoindex_search_query_allowlist_1
    LEFT JOIN search_chat_state state ON state.chat_id = allowed.chat_id
  `;
  const rows = afterChatId === null
    ? db.query<AllowedStateRow, [number]>(`
      ${select}
      ORDER BY allowed.chat_id LIMIT ?
    `).all(SEARCH_READER_MAX_SQL_ROWS)
    : db.query<AllowedStateRow, [string, number]>(`
      ${select}
      WHERE allowed.chat_id > ?
      ORDER BY allowed.chat_id LIMIT ?
    `).all(afterChatId, SEARCH_READER_MAX_SQL_ROWS);
  for (const row of rows) {
    validateAllowed(row);
    if (!(row.stateTranscriptViewId === null || typeof row.stateTranscriptViewId === 'string')
        || !(row.status === null || typeof row.status === 'string')
        || !(row.phase === null || typeof row.phase === 'string')
        || !(row.targetThrough === null || Number.isSafeInteger(row.targetThrough))
        || !(row.processedThrough === null || Number.isSafeInteger(row.processedThrough))) {
      corruption();
    }
  }
  return rows;
}

function allowedEntry(row: AllowedStateRow): TranscriptSearchAllowedChat {
  return {
    chatId: row.chatId,
    transcriptViewId: row.transcriptViewId,
    throughOrdinal: row.throughOrdinal,
  };
}

function indexedAllowed(row: AllowedStateRow): boolean {
  return row.stateTranscriptViewId === row.transcriptViewId
    && row.status === 'indexed'
    && row.phase === 'idle'
    && row.processedThrough !== null
    && row.processedThrough >= row.throughOrdinal;
}

function* searchGenerator(
  db: Database,
  compiled: CompiledTranscriptSearchQuery,
  allowlist: TranscriptSearchAllowlist,
  limit: number,
): Generator<SliceCost, { results: ChatSearchResult[]; index: ChatSearchIndexStatus }, void> {
  let committed = false;
  db.exec('BEGIN');
  try {
    const stats = db.query<CorpusStatsRow, []>(`
      SELECT document_count AS documentCount, total_token_count AS totalTokenCount
      FROM search_corpus_stats WHERE singleton = 1
    `).get();
    yield { sqlRows: 1 };
    if (!stats || !Number.isSafeInteger(stats.documentCount) || stats.documentCount < 0
        || !Number.isSafeInteger(stats.totalTokenCount)
        || stats.totalTokenCount < stats.documentCount) corruption();

    const index: ChatSearchIndexStatus = {
      indexedChatCount: 0,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    };
    let afterAllowedChatId: string | null = null;
    while (true) {
      const rows = allowedStatePage(db, afterAllowedChatId);
      for (const row of rows) {
        if (indexedAllowed(row)) {
          index.indexedChatCount += 1;
        } else if (row.stateTranscriptViewId === row.transcriptViewId
            && row.status === 'failed'
            && row.targetThrough !== null
            && row.targetThrough >= row.throughOrdinal) {
          index.failedChatCount += 1;
        } else {
          index.pendingChatCount += 1;
        }
      }
      yield {
        sqlRows: Math.max(1, rows.length),
        positionOperations: rows.length,
      };
      if (rows.length === 0) break;
      afterAllowedChatId = rows[rows.length - 1].chatId;
    }

    if (compiled.clauses.length === 0 || allowlist.size === 0 || stats.documentCount === 0) {
      db.exec('COMMIT');
      committed = true;
      return { results: [], index };
    }

    const documentFrequency = new Map<string, number>();
    for (const phrase of compiled.uniquePhrases) {
      let count = 0;
      if (!phrase.prefix) {
        const matches = exactDriverIterator(db, phrase.terms[0]);
        for (let next = matches.next(); !next.done; next = matches.next()) {
          if (!isExactDriverMatch(next.value)) {
            yield next.value;
            continue;
          }
          if (yield* phraseFrequency(
            db,
            next.value.chunk,
            phrase,
            next.value.posting,
          )) count += 1;
          yield { positionOperations: 1 };
        }
      } else {
        const chunks = activeChunksIterator(db);
        for (let next = chunks.next(); !next.done; next = chunks.next()) {
          if (!isActiveChunk(next.value)) {
            yield next.value;
            continue;
          }
          if (yield* phraseFrequency(db, next.value, phrase)) count += 1;
          yield { positionOperations: 1 };
        }
      }
      documentFrequency.set(phrase.key, count);
    }

    const winners: Winner[] = [];
    afterAllowedChatId = null;
    while (true) {
      const rows = allowedStatePage(db, afterAllowedChatId);
      yield { sqlRows: Math.max(1, rows.length) };
      for (const row of rows) {
        if (!indexedAllowed(row)) continue;
        const entry = allowedEntry(row);
        const best = compiled.clauses.map(() => Number.NEGATIVE_INFINITY);
        const chunks = chunksForAllowed(db, entry);
        for (let next = chunks.next(); !next.done; next = chunks.next()) {
          if (!isActiveChunk(next.value)) {
            yield next.value;
            continue;
          }
          const scores = yield* evaluateClauses(db, next.value, compiled, documentFrequency, stats);
          for (let index = 0; index < scores.length; index += 1) {
            if (scores[index] !== null) best[index] = Math.max(best[index], scores[index]!);
          }
        }
        if (best.every(Number.isFinite)) {
          updateTopWinners(winners, {
            allowed: entry,
            score: best.reduce((sum, score) => sum + score, 0),
          });
        }
        yield { positionOperations: Math.max(1, best.length) };
      }
      if (rows.length === 0) break;
      afterAllowedChatId = rows[rows.length - 1].chatId;
    }

    const selected = winners.slice(0, limit);
    const results: ChatSearchResult[] = [];
    for (const winner of selected) {
      let matchedMessageCount = 0;
      const snippetIdentities: SnippetIdentity[] = [];
      const chunks = chunksForAllowed(db, winner.allowed);
      for (let next = chunks.next(); !next.done; next = chunks.next()) {
        if (!isActiveChunk(next.value)) {
          yield next.value;
          continue;
        }
        const scores = yield* evaluateClauses(db, next.value, compiled, documentFrequency, stats);
        const matching = scores.filter((score): score is number => score !== null);
        if (matching.length > 0) {
          matchedMessageCount += 1;
          updateTopSnippets(snippetIdentities, {
            chunk: next.value,
            score: matching.reduce((sum, score) => sum + score, 0),
          });
        }
        yield { positionOperations: Math.max(1, scores.length) };
      }

      const snippets: ChatSearchResult['snippets'] = [];
      for (const identity of snippetIdentities) {
        const row = db.query<{ body: string }, [number]>(
          'SELECT body FROM search_chunks WHERE id = ?',
        ).get(identity.chunk.id);
        const bodyBytes = row ? Buffer.byteLength(row.body) : 0;
        yield { sqlRows: 1, bodyRows: 1, bodyBytes };
        if (!row || bodyBytes < 1 || bodyBytes > SEARCH_READER_MAX_BODY_BYTES) corruption();
        const tokens = yield* snippetTokens(row.body);
        const firstMatch = yield* firstQueryMatch(tokens, compiled);
        snippets.push({
          ordinal: identity.chunk.ordinal,
          role: roleName(identity.chunk.role),
          timestamp: identity.chunk.timestamp,
          text: snippetWindow(row.body, tokens, firstMatch),
        });
      }
      results.push({
        chatId: winner.allowed.chatId,
        transcriptViewId: winner.allowed.transcriptViewId,
        score: winner.score,
        matchedMessageCount,
        snippets,
      });
    }

    db.exec('COMMIT');
    committed = true;
    return { results, index };
  } finally {
    if (!committed) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The connection is retired after a failed rollback.
      }
    }
  }
}

export class TranscriptSearchReaderSession {
  readonly #generator: Generator<
    SliceCost,
    { results: ChatSearchResult[]; index: ChatSearchIndexStatus },
    void
  >;
  readonly #allowlist: TranscriptSearchAllowlist;
  #closed = false;

  constructor(
    db: Database,
    compiled: CompiledTranscriptSearchQuery,
    allowlist: TranscriptSearchAllowlist,
    limit?: number,
  ) {
    allowlist.seal();
    this.#allowlist = allowlist;
    this.#generator = searchGenerator(db, compiled, allowlist, clampLimit(limit));
  }

  step(): TranscriptSearchReaderStep {
    if (this.#closed) throw new Error('SEARCH_READER_SESSION_CLOSED');
    try {
      const next = this.#generator.next();
      if (next.done) {
        this.#allowlist.close();
        this.#closed = true;
        const metrics = emptyMetrics();
        return { type: 'complete', metrics, result: next.value };
      }
      const metrics = emptyMetrics(next.value);
      assertSliceMetrics(metrics);
      return { type: 'continue', metrics };
    } catch (error) {
      try {
        this.#generator.return({
          results: [],
          index: {
            indexedChatCount: 0,
            pendingChatCount: 0,
            failedChatCount: 0,
            unsupportedChatCount: 0,
          },
        });
      } catch {
        // The original reader failure remains authoritative.
      }
      try {
        this.#allowlist.close();
      } catch {
        // The original reader failure remains authoritative.
      }
      this.#closed = true;
      throw error;
    }
  }

  cancel(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#generator.return({
        results: [],
        index: {
          indexedChatCount: 0,
          pendingChatCount: 0,
          failedChatCount: 0,
          unsupportedChatCount: 0,
        },
      });
    } finally {
      this.#allowlist.close();
    }
  }
}

export function createTranscriptSearchAllowlist(db: Database): TranscriptSearchAllowlist {
  return new TranscriptSearchAllowlist(db);
}

export function createTranscriptSearchReaderSessionFromAllowlist(
  db: Database,
  compiled: CompiledTranscriptSearchQuery,
  allowlist: TranscriptSearchAllowlist,
  options: { readonly limit?: number } = {},
): TranscriptSearchReaderSession {
  return new TranscriptSearchReaderSession(db, compiled, allowlist, options.limit);
}

export function createTranscriptSearchReaderSession(
  db: Database,
  compiled: CompiledTranscriptSearchQuery,
  options: {
    readonly allowedChats: readonly TranscriptSearchAllowedChat[];
    readonly limit?: number;
  },
): TranscriptSearchReaderSession {
  const allowlist = createTranscriptSearchAllowlist(db);
  try {
    allowlist.append(options.allowedChats);
    return createTranscriptSearchReaderSessionFromAllowlist(db, compiled, allowlist, options);
  } catch (error) {
    try {
      allowlist.close();
    } catch {
      // The original allowlist failure remains authoritative.
    }
    throw error;
  }
}

export function searchTranscriptIndexV1(
  db: Database,
  options: {
    readonly query: ChatSearchQueryV1;
    readonly allowedChats: readonly TranscriptSearchAllowedChat[];
    readonly limit?: number;
    readonly tokenizer?: Pick<SearchTokenizer, 'tokenizeQuery'>;
  },
): { results: ChatSearchResult[]; index: ChatSearchIndexStatus } {
  const ownedTokenizer = options.tokenizer ? null : SearchTokenizer.create();
  const tokenizer = options.tokenizer ?? ownedTokenizer!;
  let compiled: CompiledTranscriptSearchQuery;
  try {
    compiled = compileTranscriptSearchQueryV1(tokenizer, options.query);
  } finally {
    ownedTokenizer?.close();
  }
  const session = createTranscriptSearchReaderSession(db, compiled, options);
  while (true) {
    const step = session.step();
    if (step.type === 'complete') {
      return { results: [...step.result.results], index: step.result.index };
    }
  }
}
