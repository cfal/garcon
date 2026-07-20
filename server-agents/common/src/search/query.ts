import type { Database } from 'bun:sqlite';
import type {
  ChatSearchIndexStatus,
  ChatSearchClauseV1,
  ChatSearchQueryV1,
  ChatSearchResult,
  ChatSearchSnippetRole,
  ChatSearchTokenV1,
} from '@garcon/common/chat-search';
import {
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
  CHAT_SEARCH_MIN_PREFIX_CHARS,
} from '@garcon/common/chat-search';

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const SNIPPETS_PER_CHAT = 3;
const MAX_SNIPPET_CHARS = 512;

interface CompiledTerm {
  query: string;
  words: string[];
  normalizedWords: string[];
  exactPhrase: boolean;
  prefixWords: boolean[];
}

interface ResultRow {
  chatId: string;
  rank: number;
}

interface FtsSnippetMatchRow {
  rowId: number;
  chatId: string;
  messageOrdinal: number;
  role: number;
  timestamp: string | null;
  rank: number;
}

interface SnippetToken {
  normalized: string;
  start: number;
  end: number;
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

function snippetWindow(body: string, tokens: SnippetToken[], firstTokenIndex: number): string {
  if (tokens.length === 0) return '';
  const startToken = Math.max(0, firstTokenIndex - 8);
  const endToken = Math.min(tokens.length, startToken + 32);
  const raw = body.slice(tokens[startToken].start, tokens[endToken - 1].end);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const characters = [...normalized];
  const text = characters.slice(0, MAX_SNIPPET_CHARS).join('');
  const hasSuffix = endToken < tokens.length || characters.length > MAX_SNIPPET_CHARS;
  return `${startToken > 0 ? '... ' : ''}${text}${hasSuffix ? ' ...' : ''}`;
}

function quotedValues(query: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const match of query.matchAll(/"([^"]+)"|'([^']+)'/g)) {
    const value = (match[1] ?? match[2] ?? '').toLowerCase();
    values.set(value, (values.get(value) ?? 0) + 1);
  }
  return values;
}

function rawTerms(query: string, textTokens?: string[]): Array<{ text: string; quoted: boolean }> {
  if (textTokens?.length) {
    const quoted = quotedValues(query);
    return textTokens.map((text) => {
      const key = text.toLowerCase();
      const quotedCount = quoted.get(key) ?? 0;
      if (quotedCount > 0) quoted.set(key, quotedCount - 1);
      return { text, quoted: /\s/u.test(text) || quotedCount > 0 };
    });
  }
  const terms: Array<{ text: string; quoted: boolean }> = [];
  const matcher = /"([^"]+)"|'([^']+)'|(\S+)/g;
  for (const match of query.matchAll(matcher)) {
    terms.push({
      text: match[1] ?? match[2] ?? match[3] ?? '',
      quoted: match[1] !== undefined || match[2] !== undefined,
    });
  }
  return terms;
}

export function compileSearchTerms(query: string, textTokens?: string[]): CompiledTerm[] {
  const sourceTerms = rawTerms(query, textTokens);
  if (sourceTerms.length > CHAT_SEARCH_MAX_TERMS) {
    throw new RangeError(`Transcript search accepts at most ${CHAT_SEARCH_MAX_TERMS} terms`);
  }
  const terms: CompiledTerm[] = [];
  let wordCount = 0;
  for (const raw of sourceTerms) {
    const words = wordsIn(raw.text);
    if (words.length === 0) continue;
    if (wordCount + words.length > CHAT_SEARCH_MAX_WORDS) {
      throw new RangeError(`Transcript search accepts at most ${CHAT_SEARCH_MAX_WORDS} words`);
    }
    wordCount += words.length;
    const compiled = raw.quoted
      ? `"${words.join(' ').replaceAll('"', '""')}"`
      : words.map((word) => [...word].length >= CHAT_SEARCH_MIN_PREFIX_CHARS
        ? `${escapeFtsWord(word)}*`
        : escapeFtsWord(word)).join(' AND ');
    terms.push({
      query: compiled,
      words,
      normalizedWords: words.map(normalizeFtsToken),
      exactPhrase: raw.quoted,
      prefixWords: words.map((word) => !raw.quoted && [...word].length >= CHAT_SEARCH_MIN_PREFIX_CHARS),
    });
  }
  return terms;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit)) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.max(1, Number(limit)));
}

function prepareAllowed(allowedChatIds: string[]): string[] {
  return uniqueStrings(allowedChatIds);
}

function searchIndexStatusForPreparedAllowed(
  db: Database,
  allowed: string[],
): ChatSearchIndexStatus {
  if (allowed.length === 0) {
    return { indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 };
  }
  const counts = db.query<{
    indexed: number;
    failed: number;
    unsupported: number;
  }, [string]>(`
    WITH allowed(chat_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )
    SELECT
      COALESCE(SUM(CASE WHEN state.status = 'sealed' THEN 1 ELSE 0 END), 0) AS indexed,
      COALESCE(SUM(CASE WHEN state.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN state.status = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported
    FROM allowed
    LEFT JOIN search_chat_state state ON state.chat_id = allowed.chat_id
  `).get(JSON.stringify(allowed)) ?? { indexed: 0, failed: 0, unsupported: 0 };
  const indexedChatCount = Number(counts.indexed);
  const failedChatCount = Number(counts.failed);
  const unsupportedChatCount = Number(counts.unsupported);
  return {
    indexedChatCount,
    failedChatCount,
    unsupportedChatCount,
    pendingChatCount: Math.max(
      0,
      allowed.length - indexedChatCount - failedChatCount - unsupportedChatCount,
    ),
  };
}

export function searchIndexStatus(db: Database, allowedChatIds: string[]): ChatSearchIndexStatus {
  return searchIndexStatusForPreparedAllowed(db, prepareAllowed(allowedChatIds));
}

function collectSnippets(
  db: Database,
  resultRows: ResultRow[],
  terms: CompiledTerm[],
): Map<string, { matchedMessageCount: number; snippets: ChatSearchResult['snippets'] }> {
  if (resultRows.length === 0) return new Map();
  const snippetQuery = [...new Set(terms.map((term) => term.query))]
    .map((term) => `(${term})`)
    .join(' OR ');
  const rows = db.query<FtsSnippetMatchRow, [string, string]>(`
    WITH results(chat_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )
    SELECT
      chunks.id AS rowId,
      chunks.chat_id AS chatId,
      chunks.message_ordinal AS messageOrdinal,
      chunks.role AS role,
      chunks.timestamp AS timestamp,
      search_chunks_fts.rank AS rank
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    JOIN results ON results.chat_id = chunks.chat_id
    WHERE search_chunks_fts MATCH ?
  `).all(JSON.stringify(resultRows.map((row) => row.chatId)), `body:(${snippetQuery})`);
  const matches = new Map<string, {
    matchedMessageCount: number;
    ranked: FtsSnippetMatchRow[];
  }>();
  for (const row of rows) {
    const current = matches.get(row.chatId) ?? { matchedMessageCount: 0, ranked: [] };
    current.matchedMessageCount += 1;
    current.ranked.push(row);
    current.ranked.sort((left, right) =>
      left.rank - right.rank || left.messageOrdinal - right.messageOrdinal);
    if (current.ranked.length > SNIPPETS_PER_CHAT) current.ranked.pop();
    matches.set(row.chatId, current);
  }
  const bodyStatement = db.prepare<{ body: string }, [number]>('SELECT body FROM search_chunks WHERE id = ?');
  const response = new Map([...matches].map(([chatId, match]) => [chatId, {
    matchedMessageCount: match.matchedMessageCount,
    snippets: match.ranked.map((candidate) => {
      const body = bodyStatement.get(candidate.rowId)?.body ?? '';
      const tokens = tokenizeForSnippet(body);
      const firstTokenIndex = matchSnippetTerms(tokens, terms);
      return {
        messageOrdinal: Number(candidate.messageOrdinal),
        role: publicRole(candidate.role),
        timestamp: candidate.timestamp,
        text: snippetWindow(body, tokens, firstTokenIndex ?? 0),
      };
    }),
  }]));
  bodyStatement.finalize();
  return response;
}

function collectSingleTermResults(
  db: Database,
  term: CompiledTerm,
  allowed: string[],
  limit: number,
): ResultRow[] {
  return db.query<ResultRow, [string, string, number]>(`
    WITH allowed(chat_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    )
    SELECT
      chunks.chat_id AS chatId,
      MIN(search_chunks_fts.rank) AS rank
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    JOIN allowed ON allowed.chat_id = chunks.chat_id
    WHERE search_chunks_fts MATCH ?
    GROUP BY chunks.chat_id
    ORDER BY rank ASC, chatId ASC
    LIMIT ?
  `).all(JSON.stringify(allowed), `body:(${term.query})`, limit);
}

export function searchTranscriptIndex(
  db: Database,
  options: {
    query: string;
    textTokens?: string[];
    allowedChatIds: string[];
    limit?: number;
  },
): { results: ChatSearchResult[]; index: ChatSearchIndexStatus } {
  const allowed = prepareAllowed(options.allowedChatIds);
  const index = searchIndexStatusForPreparedAllowed(db, allowed);
  const terms = compileSearchTerms(options.query, options.textTokens);
  if (allowed.length === 0 || terms.length === 0) return { results: [], index };

  const limit = clampLimit(options.limit);
  const resultRows = terms.length === 1
    ? collectSingleTermResults(db, terms[0], allowed, limit)
    : collectMultiTermResults(db, terms, allowed, limit);
  const snippetByChat = collectSnippets(db, resultRows, terms);
  return {
    results: resultRows.map((row) => {
      const snippets = snippetByChat.get(row.chatId) ?? { matchedMessageCount: 0, snippets: [] };
      return {
        chatId: row.chatId,
        score: -Number(row.rank || 0),
        matchedMessageCount: snippets.matchedMessageCount,
        snippets: snippets.snippets,
      };
    }),
    index,
  };
}

export function searchTranscriptIndexV1(
  db: Database,
  options: {
    query: ChatSearchQueryV1;
    allowedChatIds: string[];
    limit?: number;
  },
): { results: ChatSearchResult[]; index: ChatSearchIndexStatus } {
  const allowed = prepareAllowed(options.allowedChatIds);
  const index = searchIndexStatusForPreparedAllowed(db, allowed);
  const terms = compileStructuredTerms(options.query);
  if (allowed.length === 0 || terms.length === 0) return { results: [], index };
  const limit = clampLimit(options.limit);
  const resultRows = terms.length === 1
    ? collectSingleTermResults(db, terms[0], allowed, limit)
    : collectMultiTermResults(db, terms, allowed, limit);
  const snippetByChat = collectSnippets(db, resultRows, terms);
  return {
    results: resultRows.map((row) => {
      const snippets = snippetByChat.get(row.chatId) ?? { matchedMessageCount: 0, snippets: [] };
      return {
        chatId: row.chatId,
        score: -Number(row.rank || 0),
        matchedMessageCount: snippets.matchedMessageCount,
        snippets: snippets.snippets,
      };
    }),
    index,
  };
}

function collectMultiTermResults(
  db: Database,
  terms: CompiledTerm[],
  allowed: string[],
  limit: number,
): ResultRow[] {
  const selects = terms.map((_, index) => `
    SELECT chunks.chat_id AS chat_id, ${index} AS term_ordinal,
      MIN(search_chunks_fts.rank) AS best_rank
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    JOIN allowed ON allowed.chat_id = chunks.chat_id
    WHERE search_chunks_fts MATCH ?
    GROUP BY chunks.chat_id
  `).join(' UNION ALL ');
  const sql = `
    WITH allowed(chat_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(?)
    ), term_matches AS (${selects})
    SELECT chat_id AS chatId, SUM(best_rank) AS rank
    FROM term_matches
    GROUP BY chat_id
    HAVING COUNT(DISTINCT term_ordinal) = ?
    ORDER BY rank ASC, chat_id ASC
    LIMIT ?
  `;
  const parameters: Array<string | number> = [
    JSON.stringify(allowed),
    ...terms.map((term) => `body:(${term.query})`),
    terms.length,
    limit,
  ];
  return db.query<ResultRow, Array<string | number>>(sql).all(...parameters);
}
