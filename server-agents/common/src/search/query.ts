import type { Database } from 'bun:sqlite';
import type {
  ChatSearchIndexStatus,
  ChatSearchPage,
  ChatSearchClauseV1,
  ChatSearchQueryV1,
  ChatSearchResult,
  ChatSearchResultMode,
  ChatSearchSnippetRole,
  ChatSearchTokenV1,
  TranscriptSearchAllowedChat,
} from '@garcon/common/chat-search';
import {
  CHAT_SEARCH_DEFAULT_PAGE_SIZE,
  CHAT_SEARCH_MAX_OFFSET,
  CHAT_SEARCH_MAX_PAGE_SIZE,
  CHAT_SEARCH_MAX_PREFIX_SIZE,
  CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS,
  CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT,
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
} from '@garcon/common/chat-search';
import type { TranscriptSearchOrder } from './worker-protocol.js';

const SNIPPET_PREFIX = '... ';
const SNIPPET_SUFFIX = ' ...';
const MAX_SNIPPET_CHARS = CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS
  - [...SNIPPET_PREFIX].length
  - [...SNIPPET_SUFFIX].length;
export const SEARCH_QUERY_MATCH_ROW_LIMIT = 10_000;

const SEARCHABLE_STATE_JOIN = `
    JOIN search_chat_state state ON state.chat_id = chunks.chat_id
      AND state.transcript_view_id = chunks.transcript_view_id
      AND state.status IN ('pending', 'indexed')
      AND chunks.ordinal <= state.indexed_through
`;

interface CompiledTerm {
  query: string;
  words: string[];
  normalizedWords: string[];
  exactPhrase: boolean;
  prefixWords: boolean[];
}

interface ResultRow {
  chatId: string;
  transcriptViewId: string;
  rank: number;
}

interface FtsSnippetMatchRow {
  rowId: number;
  chatId: string;
  transcriptViewId: string;
  ordinal: number;
  role: number;
  timestamp: string | null;
  rank: number;
}

interface SnippetToken {
  normalized: string;
  start: number;
  end: number;
}

interface SnippetMatch {
  matchedMessageCount: number;
  ranked: FtsSnippetMatchRow[];
}

function escapeFtsWord(word: string): string {
  return `"${word.replaceAll('"', '""')}"`;
}

function wordsIn(value: string): string[] {
  return value.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function normalizeFtsToken(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function tokenizeForSnippet(body: string): SnippetToken[] {
  return [...body.matchAll(/[\p{L}\p{N}_]+/gu)].map((match) => ({
    normalized: normalizeFtsToken(match[0]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function tokenMatchesWord(token: SnippetToken, normalizedWord: string, prefix: boolean): boolean {
  return prefix ? token.normalized.startsWith(normalizedWord) : token.normalized === normalizedWord;
}

function matchSnippetTerm(
  tokens: SnippetToken[],
  term: CompiledTerm,
): number | null {
  if (term.exactPhrase) {
    for (let start = 0; start + term.words.length <= tokens.length; start += 1) {
      if (term.normalizedWords.every(
        (word, offset) => tokenMatchesWord(tokens[start + offset], word, false),
      )) {
        return start;
      }
    }
    return null;
  }

  let firstTokenIndex = Number.POSITIVE_INFINITY;
  for (let wordIndex = 0; wordIndex < term.words.length; wordIndex += 1) {
    const prefix = term.prefixWords[wordIndex];
    const word = term.normalizedWords[wordIndex];
    let firstMatch = -1;
    for (let index = 0; index < tokens.length; index += 1) {
      if (!tokenMatchesWord(tokens[index], word, prefix)) continue;
      if (firstMatch < 0) firstMatch = index;
    }
    if (firstMatch < 0) return null;
    firstTokenIndex = Math.min(firstTokenIndex, firstMatch);
  }
  return firstTokenIndex;
}

function matchSnippetTerms(
  tokens: SnippetToken[],
  terms: CompiledTerm[],
): number | null {
  let firstTokenIndex = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    const match = matchSnippetTerm(tokens, term);
    if (match === null) continue;
    firstTokenIndex = Math.min(firstTokenIndex, match);
  }
  return Number.isFinite(firstTokenIndex) ? firstTokenIndex : null;
}

function publicRole(role: number): ChatSearchSnippetRole {
  if (role === 0) return 'user';
  if (role === 1) return 'assistant';
  if (role === 2) return 'tool';
  return 'system';
}

function resultKey(chatId: string, transcriptViewId: string): string {
  return `${chatId.length}:${chatId}${transcriptViewId}`;
}

function snippetWindow(body: string, tokens: SnippetToken[], firstTokenIndex: number): string {
  if (tokens.length === 0) return '';
  const startToken = Math.max(0, firstTokenIndex - 8);
  const endToken = Math.min(tokens.length, startToken + 32);
  const raw = body.slice(tokens[startToken].start, tokens[endToken - 1].end);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  const text = characters.slice(0, MAX_SNIPPET_CHARS).join('');
  const hasSuffix = endToken < tokens.length || characters.length > MAX_SNIPPET_CHARS;
  return `${startToken > 0 ? SNIPPET_PREFIX : ''}${text}${hasSuffix ? SNIPPET_SUFFIX : ''}`;
}

function compileStructuredTerms(query: ChatSearchQueryV1): CompiledTerm[] {
  if (query.version !== 1 || !Array.isArray(query.clauses)
      || query.clauses.length > CHAT_SEARCH_MAX_TERMS) {
    throw new RangeError(`Transcript search accepts at most ${CHAT_SEARCH_MAX_TERMS} terms`);
  }
  let wordCount = 0;
  return query.clauses.map((clause: ChatSearchClauseV1) => {
    if ((clause.kind !== 'phrase' && clause.kind !== 'all-words')
        || !Array.isArray(clause.tokens) || clause.tokens.length === 0) {
      throw new RangeError('Transcript search query is invalid');
    }
    wordCount += clause.tokens.length;
    if (wordCount > CHAT_SEARCH_MAX_WORDS) {
      throw new RangeError(`Transcript search accepts at most ${CHAT_SEARCH_MAX_WORDS} words`);
    }
    const words = clause.tokens.map((token: ChatSearchTokenV1) => {
      const parsed = wordsIn(token.text);
      if (parsed.length !== 1
          || normalizeFtsToken(parsed[0]) !== token.normalized
          || (token.match !== 'exact' && token.match !== 'prefix')) {
        throw new RangeError('Transcript search token is invalid');
      }
      return parsed[0];
    });
    const exactPhrase = clause.kind === 'phrase';
    const prefixWords = clause.tokens.map(
      (token: ChatSearchTokenV1) => !exactPhrase && token.match === 'prefix',
    );
    return {
      query: exactPhrase
        ? `"${words.join(' ').replaceAll('"', '""')}"`
        : words.map((word: string, index: number) => prefixWords[index]
          ? `${escapeFtsWord(word)}*`
          : escapeFtsWord(word)).join(' AND '),
      words,
      normalizedWords: clause.tokens.map((token: ChatSearchTokenV1) => token.normalized),
      exactPhrase,
      prefixWords,
    };
  });
}

function clampLimit(limit: number | undefined, mode: ChatSearchResultMode): number {
  if (!Number.isInteger(limit)) return CHAT_SEARCH_DEFAULT_PAGE_SIZE;
  const maximum = mode === 'prefix' ? CHAT_SEARCH_MAX_PREFIX_SIZE : CHAT_SEARCH_MAX_PAGE_SIZE;
  return Math.min(maximum, Math.max(1, Number(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isSafeInteger(offset)) return 0;
  return Math.min(CHAT_SEARCH_MAX_OFFSET, Math.max(0, Number(offset)));
}

function clampSnippetLimit(snippetLimit: number | undefined): number {
  if (!Number.isInteger(snippetLimit)) return CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT;
  return Math.min(CHAT_SEARCH_MAX_SNIPPETS_PER_CHAT, Math.max(1, Number(snippetLimit)));
}

function prepareAllowed(allowedChats: readonly TranscriptSearchAllowedChat[]): TranscriptSearchAllowedChat[] {
  const prepared = new Map<string, TranscriptSearchAllowedChat>();
  for (const entry of allowedChats) {
    const chatId = entry.chatId.trim();
    const transcriptViewId = entry.transcriptViewId.trim();
    if (!chatId || !transcriptViewId) continue;
    if (!Number.isSafeInteger(entry.throughOrdinal) || entry.throughOrdinal < 0) {
      throw new RangeError('Transcript search allowlist frontier is invalid');
    }
    const existing = prepared.get(chatId);
    if (existing && (
      existing.transcriptViewId !== transcriptViewId
      || existing.throughOrdinal !== entry.throughOrdinal
    )) {
      throw new RangeError('Transcript search allowlist has contradictory snapshots');
    }
    prepared.set(chatId, { chatId, transcriptViewId, throughOrdinal: entry.throughOrdinal });
  }
  return [...prepared.values()];
}

function stageAllowedChats(
  db: Database,
  allowed: readonly TranscriptSearchAllowedChat[],
): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS search_allowed_chats (
      chat_id TEXT PRIMARY KEY,
      transcript_view_id TEXT NOT NULL,
      through_ordinal INTEGER NOT NULL
    ) WITHOUT ROWID, STRICT;
    DELETE FROM temp.search_allowed_chats;
  `);
  db.query(`
    INSERT INTO temp.search_allowed_chats(chat_id, transcript_view_id, through_ordinal)
    SELECT json_extract(value, '$.chatId'), json_extract(value, '$.transcriptViewId'),
      json_extract(value, '$.throughOrdinal')
    FROM json_each(?)
  `).run(JSON.stringify(allowed));
}

function retainSnippetCandidate(
  match: SnippetMatch,
  row: FtsSnippetMatchRow,
  snippetLimit: number,
): void {
  match.matchedMessageCount += 1;
  match.ranked.push(row);
  match.ranked.sort((left, right) =>
    left.rank - right.rank || left.ordinal - right.ordinal);
  if (match.ranked.length > snippetLimit) match.ranked.pop();
}

function hydrateSnippets(
  db: Database,
  resultRows: readonly ResultRow[],
  terms: readonly CompiledTerm[],
  matches: ReadonlyMap<string, SnippetMatch>,
): Map<string, { matchedMessageCount: number; snippets: ChatSearchResult['snippets'] }> {
  const bodyStatement = db.prepare<{ body: string }, [number]>('SELECT body FROM search_chunks WHERE id = ?');
  try {
    return new Map(resultRows.flatMap((result) => {
      const key = resultKey(result.chatId, result.transcriptViewId);
      const match = matches.get(key);
      if (!match) return [];
      return [[key, {
        matchedMessageCount: match.matchedMessageCount,
        snippets: match.ranked.map((candidate) => {
          const body = bodyStatement.get(candidate.rowId)?.body ?? '';
          const tokens = tokenizeForSnippet(body);
          const firstTokenIndex = matchSnippetTerms(tokens, [...terms]);
          return {
            ordinal: Number(candidate.ordinal),
            role: publicRole(candidate.role),
            timestamp: candidate.timestamp,
            text: snippetWindow(body, tokens, firstTokenIndex ?? 0),
          };
        }),
      }] as const];
    }));
  } finally {
    bodyStatement.finalize();
  }
}

function searchIndexStatusForPreparedAllowed(
  db: Database,
  allowed: readonly TranscriptSearchAllowedChat[],
): ChatSearchIndexStatus {
  if (allowed.length === 0) {
    return {
      indexedChatCount: 0,
      pendingChatCount: 0,
      failedChatCount: 0,
      unindexedChatCount: 0,
      unsupportedChatCount: 0,
      resultsTruncated: false,
    };
  }
  const counts = db.query<{
    indexed: number;
    failed: number;
  }, []>(`
    SELECT
      COALESCE(SUM(CASE WHEN state.status = 'indexed'
        AND state.indexed_through >= allowed.through_ordinal THEN 1 ELSE 0 END), 0) AS indexed,
      COALESCE(SUM(CASE WHEN state.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
    FROM temp.search_allowed_chats allowed
    LEFT JOIN search_chat_state state ON state.chat_id = allowed.chat_id
      AND state.transcript_view_id = allowed.transcript_view_id
  `).get() ?? { indexed: 0, failed: 0 };
  const indexedChatCount = Number(counts.indexed);
  const failedChatCount = Number(counts.failed);
  return {
    indexedChatCount,
    failedChatCount,
    unindexedChatCount: 0,
    unsupportedChatCount: 0,
    resultsTruncated: false,
    pendingChatCount: Math.max(
      0,
      allowed.length - indexedChatCount - failedChatCount,
    ),
  };
}

interface TermMatch extends ResultRow {
  readonly rows: FtsSnippetMatchRow[];
}

function collectBoundedTermMatches(
  db: Database,
  term: CompiledTerm,
): { matches: Map<string, TermMatch>; truncated: boolean } {
  const rows = db.query<FtsSnippetMatchRow, [string, number]>(`
    SELECT
      chunks.id AS rowId,
      chunks.chat_id AS chatId,
      chunks.transcript_view_id AS transcriptViewId,
      chunks.ordinal AS ordinal,
      chunks.role AS role,
      chunks.timestamp AS timestamp,
      search_chunks_fts.rank AS rank
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    ${SEARCHABLE_STATE_JOIN}
    JOIN temp.search_allowed_chats allowed ON allowed.chat_id = chunks.chat_id
      AND allowed.transcript_view_id = chunks.transcript_view_id
      AND chunks.ordinal <= allowed.through_ordinal
    WHERE search_chunks_fts MATCH ?
    ORDER BY search_chunks_fts.rowid DESC
    LIMIT ?
  `).all(`body:(${term.query})`, SEARCH_QUERY_MATCH_ROW_LIMIT + 1);
  const truncated = rows.length > SEARCH_QUERY_MATCH_ROW_LIMIT;
  if (truncated) rows.length = SEARCH_QUERY_MATCH_ROW_LIMIT;
  const matches = new Map<string, TermMatch>();
  for (const row of rows) {
    const key = resultKey(row.chatId, row.transcriptViewId);
    const current = matches.get(key) ?? {
      chatId: row.chatId,
      transcriptViewId: row.transcriptViewId,
      rank: row.rank,
      rows: [],
    };
    current.rank = Math.min(current.rank, row.rank);
    current.rows.push(row);
    matches.set(key, current);
  }
  return { matches, truncated };
}

function compareResultRows(
  left: ResultRow,
  right: ResultRow,
  order: TranscriptSearchOrder,
  priorityByChatId: ReadonlyMap<string, number> | null,
): number {
  if (order === 'allowlist') {
    const priority = (priorityByChatId?.get(left.chatId) ?? Number.MAX_SAFE_INTEGER)
      - (priorityByChatId?.get(right.chatId) ?? Number.MAX_SAFE_INTEGER);
    if (priority !== 0) return priority;
  } else {
    const rank = left.rank - right.rank;
    if (rank !== 0) return rank;
  }
  return left.chatId.localeCompare(right.chatId)
    || left.transcriptViewId.localeCompare(right.transcriptViewId);
}

function collectBoundedSearch(
  db: Database,
  terms: CompiledTerm[],
  allowed: readonly TranscriptSearchAllowedChat[],
  options: {
    readonly order: TranscriptSearchOrder;
    readonly offset: number;
    readonly limit: number;
    readonly snippetLimit: number;
  },
): {
  resultRows: ResultRow[];
  snippetByChat: Map<string, {
    matchedMessageCount: number;
    snippets: ChatSearchResult['snippets'];
  }>;
  page: ChatSearchPage;
  truncated: boolean;
} {
  const termMatches = terms.map((term) => collectBoundedTermMatches(db, term));
  const first = termMatches[0]?.matches ?? new Map<string, TermMatch>();
  const priorityByChatId = options.order === 'allowlist'
    ? new Map(allowed.map((entry, index) => [entry.chatId, index]))
    : null;
  const orderedRows = [...first.entries()]
    .filter(([key]) => termMatches.every((term) => term.matches.has(key)))
    .map(([key, match]) => ({
      chatId: match.chatId,
      transcriptViewId: match.transcriptViewId,
      rank: termMatches.reduce((sum, term) => sum + term.matches.get(key)!.rank, 0),
    }))
    .sort((left, right) => compareResultRows(left, right, options.order, priorityByChatId));
  const resultRows = orderedRows.slice(options.offset, options.offset + options.limit);
  const nextOffset = options.offset + resultRows.length;
  const hasMore = nextOffset < orderedRows.length;
  const snippets = new Map<string, SnippetMatch>();
  for (const result of resultRows) {
    const key = resultKey(result.chatId, result.transcriptViewId);
    const rows = new Map<number, FtsSnippetMatchRow>();
    for (const term of termMatches) {
      for (const row of term.matches.get(key)?.rows ?? []) rows.set(row.rowId, row);
    }
    const match: SnippetMatch = { matchedMessageCount: 0, ranked: [] };
    for (const row of rows.values()) retainSnippetCandidate(match, row, options.snippetLimit);
    snippets.set(key, match);
  }
  return {
    resultRows,
    snippetByChat: hydrateSnippets(db, resultRows, terms, snippets),
    page: {
      offset: options.offset,
      limit: options.limit,
      total: orderedRows.length,
      hasMore,
      nextOffset: hasMore ? nextOffset : null,
    },
    truncated: termMatches.some((term) => term.truncated),
  };
}

export function searchTranscriptIndexV1(
  db: Database,
  options: {
    query: ChatSearchQueryV1;
    allowedChats: readonly TranscriptSearchAllowedChat[];
    order?: TranscriptSearchOrder;
    mode?: ChatSearchResultMode;
    offset?: number;
    limit?: number;
    snippetLimit?: number;
  },
): {
  mode: ChatSearchResultMode;
  snippetLimit: number;
  results: ChatSearchResult[];
  page: ChatSearchPage;
  index: ChatSearchIndexStatus;
} {
  const mode = options.mode ?? 'page';
  const snippetLimit = clampSnippetLimit(options.snippetLimit);
  if (mode === 'prefix' && (options.offset ?? 0) !== 0) {
    throw new RangeError('Transcript search prefix offset must be zero');
  }
  if (mode === 'prefix' && snippetLimit !== 1) {
    throw new RangeError('Transcript search prefix requires one snippet');
  }
  const allowed = prepareAllowed(options.allowedChats);
  stageAllowedChats(db, allowed);
  const index = searchIndexStatusForPreparedAllowed(db, allowed);
  const terms = compileStructuredTerms(options.query);
  const limit = clampLimit(options.limit, mode);
  const offset = clampOffset(options.offset);
  const emptyPage: ChatSearchPage = {
    offset,
    limit,
    total: 0,
    hasMore: false,
    nextOffset: null,
  };
  if (allowed.length === 0 || terms.length === 0) {
    return { mode, snippetLimit, results: [], page: emptyPage, index };
  }
  const { resultRows, snippetByChat, page, truncated } = collectBoundedSearch(
    db,
    terms,
    allowed,
    { order: options.order ?? 'relevance', offset, limit, snippetLimit },
  );
  return {
    mode,
    snippetLimit,
    results: resultRows.map((row) => {
      const snippets = snippetByChat.get(resultKey(row.chatId, row.transcriptViewId))
        ?? { matchedMessageCount: 0, snippets: [] };
      return {
        chatId: row.chatId,
        transcriptViewId: row.transcriptViewId,
        score: -Number(row.rank || 0),
        matchedMessageCount: snippets.matchedMessageCount,
        snippets: snippets.snippets,
      };
    }),
    page,
    index: { ...index, resultsTruncated: truncated },
  };
}
