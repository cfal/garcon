import type { Database } from 'bun:sqlite';
import { Buffer } from 'node:buffer';
import type {
  ChatSearchIndexStatus,
  ChatSearchResult,
  ChatSearchSnippetRole,
} from '../../../common/chat-search.js';
import {
  CHAT_SEARCH_MAX_TERMS,
  CHAT_SEARCH_MAX_WORDS,
  CHAT_SEARCH_MIN_PREFIX_CHARS,
} from '../../../common/chat-search.js';

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const SNIPPETS_PER_CHAT = 3;
const MAX_SNIPPET_CHARS = 512;
const SEARCH_CANDIDATE_CHATS = 20;
const CANDIDATE_SCOPE_BATCH = 20;

interface CompiledTerm {
  query: string;
  words: string[];
  normalizedWords: string[];
  exactPhrase: boolean;
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

function chatScope(chatId: string): string {
  return `c${Buffer.from(chatId, 'utf8').toString('hex')}`;
}

function scopedMatch(query: string, chatIds: string[]): string {
  const scopes = chatIds.map((chatId) => escapeFtsWord(chatScope(chatId))).join(' OR ');
  return `chat_scope:(${scopes}) AND body:(${query})`;
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
    const prefix = [...term.words[wordIndex]].length >= CHAT_SEARCH_MIN_PREFIX_CHARS;
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
    });
  }
  return terms;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit)) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.max(1, Number(limit)));
}

function prepareAllowed(db: Database, allowedChatIds: string[]): string[] {
  const unique = uniqueStrings(allowedChatIds);
  db.exec('CREATE TEMP TABLE IF NOT EXISTS temp_search_allowed (chat_id TEXT PRIMARY KEY) WITHOUT ROWID');
  db.query('DELETE FROM temp_search_allowed').run();
  const insert = db.query('INSERT OR IGNORE INTO temp_search_allowed (chat_id) VALUES (?)');
  for (const chatId of unique) insert.run(chatId);
  return unique;
}

function searchIndexStatusForPreparedAllowed(
  db: Database,
  allowed: string[],
): ChatSearchIndexStatus {
  if (allowed.length === 0) {
    return { indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 };
  }
  const countStatement = db.prepare<{
    indexed: number;
    failed: number;
    unsupported: number;
  }, []>(`
    SELECT
      COALESCE(SUM(CASE
        WHEN state.status = 'sealed' OR (state.status = 'dirty' AND state.message_count > 0) THEN 1
        ELSE 0
      END), 0) AS indexed,
      COALESCE(SUM(CASE WHEN state.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN state.status = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported
    FROM temp_search_allowed allowed
    LEFT JOIN search_chat_state state ON state.chat_id = allowed.chat_id
  `);
  const counts = countStatement.get() ?? { indexed: 0, failed: 0, unsupported: 0 };
  countStatement.finalize();
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
  return searchIndexStatusForPreparedAllowed(db, prepareAllowed(db, allowedChatIds));
}

function collectSnippets(
  db: Database,
  resultRows: ResultRow[],
  terms: CompiledTerm[],
): Map<string, { matchedMessageCount: number; snippets: ChatSearchResult['snippets'] }> {
  if (resultRows.length === 0) return new Map();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS temp_search_results (chat_id TEXT PRIMARY KEY) WITHOUT ROWID');
  db.query('DELETE FROM temp_search_results').run();
  const insert = db.query('INSERT INTO temp_search_results (chat_id) VALUES (?)');
  for (const row of resultRows) insert.run(row.chatId);
  const snippetQuery = [...new Set(terms.map((term) => term.query))]
    .map((term) => `(${term})`)
    .join(' OR ');
  const rows = db.query<FtsSnippetMatchRow, [string]>(`
    SELECT
      chunks.id AS rowId,
      chunks.chat_id AS chatId,
      chunks.message_ordinal AS messageOrdinal,
      chunks.role AS role,
      chunks.timestamp AS timestamp,
      search_chunks_fts.rank AS rank
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    JOIN temp_search_results results ON results.chat_id = chunks.chat_id
    WHERE search_chunks_fts MATCH ?
  `).all(scopedMatch(snippetQuery, resultRows.map((row) => row.chatId)));
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
  const statement = db.prepare<ResultRow, [string]>(`
    SELECT
      chunks.chat_id AS chatId,
      MIN(search_chunks_fts.rank) AS rank
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    JOIN temp_search_allowed allowed ON allowed.chat_id = chunks.chat_id
    WHERE search_chunks_fts MATCH ?
    GROUP BY chunks.chat_id
  `);
  const candidates: ResultRow[] = [];
  const target = Math.max(limit, SEARCH_CANDIDATE_CHATS);
  try {
    for (let offset = 0; offset < allowed.length && candidates.length < target; offset += CANDIDATE_SCOPE_BATCH) {
      candidates.push(...statement.all(scopedMatch(
        term.query,
        allowed.slice(offset, offset + CANDIDATE_SCOPE_BATCH),
      )));
    }
  } finally {
    statement.finalize();
  }
  return candidates
    .sort((left, right) => left.rank - right.rank || left.chatId.localeCompare(right.chatId))
    .slice(0, limit);
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
  const allowed = prepareAllowed(db, options.allowedChatIds);
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

function collectMultiTermResults(
  db: Database,
  terms: CompiledTerm[],
  allowed: string[],
  limit: number,
): ResultRow[] {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS temp_search_term_matches (
      chat_id TEXT NOT NULL,
      term_ordinal INTEGER NOT NULL,
      best_rank REAL NOT NULL,
      PRIMARY KEY(chat_id, term_ordinal)
    ) WITHOUT ROWID
  `);
  db.query('DELETE FROM temp_search_term_matches').run();
  const termInsert = db.prepare(`
    INSERT INTO temp_search_term_matches(chat_id, term_ordinal, best_rank)
    SELECT chunks.chat_id, ?, MIN(search_chunks_fts.rank)
    FROM search_chunks_fts
    JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
    JOIN temp_search_allowed allowed ON allowed.chat_id = chunks.chat_id
    WHERE search_chunks_fts MATCH ?
    GROUP BY chunks.chat_id
  `);
  const resultStatement = db.prepare<ResultRow, [number]>(`
    SELECT chat_id AS chatId, SUM(best_rank) AS rank
    FROM temp_search_term_matches
    GROUP BY chat_id
    HAVING COUNT(*) = ?
    ORDER BY rank ASC, chat_id ASC
  `);
  const candidates: ResultRow[] = [];
  const target = Math.max(limit, SEARCH_CANDIDATE_CHATS);
  for (let offset = 0; offset < allowed.length && candidates.length < target; offset += CANDIDATE_SCOPE_BATCH) {
    db.query('DELETE FROM temp_search_term_matches').run();
    const batch = allowed.slice(offset, offset + CANDIDATE_SCOPE_BATCH);
    terms.forEach((term, index) => termInsert.run(index, scopedMatch(term.query, batch)));
    candidates.push(...resultStatement.all(terms.length));
  }
  termInsert.finalize();
  resultStatement.finalize();
  return candidates
    .sort((left, right) => left.rank - right.rank || left.chatId.localeCompare(right.chatId))
    .slice(0, limit);
}
