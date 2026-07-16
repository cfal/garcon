import type { Database } from 'bun:sqlite';
import type {
  ChatSearchIndexStatus,
  ChatSearchResult,
  ChatSearchSnippetRole,
} from '../../../common/chat-search.js';

const DEFAULT_RESULT_LIMIT = 20;
const MAX_RESULT_LIMIT = 100;
const MAX_TERMS = 16;
const MAX_WORDS = 32;
const SNIPPETS_PER_CHAT = 3;

interface CompiledTerm {
  query: string;
  words: string[];
}

interface ResultRow {
  chatId: string;
  rank: number;
}

interface SnippetCandidateRow {
  chatId: string;
  messageOrdinal: number;
  role: ChatSearchSnippetRole;
  timestamp: string | null;
  text: string;
  matchedMessageCount: number;
}

interface RankedSnippetRow extends Omit<SnippetCandidateRow, 'text'> {
  rowId: number;
  snippetOrdinal: number;
}

function escapeFtsWord(word: string): string {
  return `"${word.replaceAll('"', '""')}"`;
}

function wordsIn(value: string): string[] {
  return value.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function rawTerms(query: string, textTokens?: string[]): Array<{ text: string; quoted: boolean }> {
  if (textTokens?.length) {
    return textTokens.map((text) => ({ text, quoted: /\s/u.test(text) }));
  }
  const terms: Array<{ text: string; quoted: boolean }> = [];
  const matcher = /"([^"]+)"|(\S+)/g;
  for (const match of query.matchAll(matcher)) {
    terms.push({ text: match[1] ?? match[2] ?? '', quoted: match[1] !== undefined });
  }
  return terms;
}

export function compileSearchTerms(query: string, textTokens?: string[]): CompiledTerm[] {
  const terms: CompiledTerm[] = [];
  let wordCount = 0;
  for (const raw of rawTerms(query, textTokens)) {
    if (terms.length >= MAX_TERMS || wordCount >= MAX_WORDS) break;
    const words = wordsIn(raw.text).slice(0, MAX_WORDS - wordCount);
    if (words.length === 0) continue;
    wordCount += words.length;
    const compiled = raw.quoted && words.length > 1
      ? `"${words.join(' ').replaceAll('"', '""')}"`
      : words.map((word) => `${escapeFtsWord(word)}*`).join(' AND ');
    terms.push({ query: compiled, words });
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
      COALESCE(SUM(CASE WHEN state.status IN ('sealed', 'dirty') THEN 1 ELSE 0 END), 0) AS indexed,
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
  const rankedStatement = db.prepare<RankedSnippetRow, [string]>(`
    WITH matching AS (
      SELECT
        chunks.id AS rowId,
        chunks.chat_id AS chatId,
        chunks.message_ordinal AS messageOrdinal,
        chunks.role AS role,
        chunks.timestamp AS timestamp,
        search_chunks_fts.rank AS rank,
        COUNT(*) OVER (PARTITION BY chunks.chat_id) AS matchedMessageCount,
        ROW_NUMBER() OVER (
          PARTITION BY chunks.chat_id
          ORDER BY search_chunks_fts.rank ASC, chunks.message_ordinal ASC
        ) AS snippetOrdinal
      FROM search_chunks_fts
      JOIN search_chunks chunks ON chunks.id = search_chunks_fts.rowid
      JOIN temp_search_results results ON results.chat_id = chunks.chat_id
      WHERE search_chunks_fts MATCH ?
    )
    SELECT rowId, chatId, messageOrdinal, role, timestamp, matchedMessageCount, snippetOrdinal
    FROM matching
    WHERE snippetOrdinal <= ${SNIPPETS_PER_CHAT}
    ORDER BY chatId, snippetOrdinal
  `);
  const ranked = rankedStatement.all(snippetQuery);
  rankedStatement.finalize();
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS temp_search_snippet_candidates (
      row_id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      message_ordinal INTEGER NOT NULL,
      role TEXT NOT NULL,
      timestamp TEXT,
      matched_message_count INTEGER NOT NULL,
      snippet_ordinal INTEGER NOT NULL
    )
  `);
  db.query('DELETE FROM temp_search_snippet_candidates').run();
  const insertCandidate = db.query(`
    INSERT INTO temp_search_snippet_candidates (
      row_id, chat_id, message_ordinal, role, timestamp,
      matched_message_count, snippet_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of ranked) {
    insertCandidate.run(
      row.rowId,
      row.chatId,
      row.messageOrdinal,
      row.role,
      row.timestamp,
      row.matchedMessageCount,
      row.snippetOrdinal,
    );
  }
  const snippetStatement = db.prepare<SnippetCandidateRow, [string]>(`
    SELECT
      candidates.chat_id AS chatId,
      candidates.message_ordinal AS messageOrdinal,
      candidates.role AS role,
      candidates.timestamp AS timestamp,
      snippet(search_chunks_fts, 0, '', '', ' ... ', 32) AS text,
      candidates.matched_message_count AS matchedMessageCount
    FROM temp_search_snippet_candidates candidates
    CROSS JOIN search_chunks_fts
      ON search_chunks_fts.rowid = candidates.row_id
    WHERE search_chunks_fts MATCH ?
    ORDER BY candidates.chat_id, candidates.snippet_ordinal
  `);
  const rows = snippetStatement.all(snippetQuery);
  snippetStatement.finalize();
  const matches = new Map<string, {
    matchedMessageCount: number;
    snippets: ChatSearchResult['snippets'];
  }>();
  for (const row of rows) {
    const current = matches.get(row.chatId) ?? { matchedMessageCount: 0, snippets: [] };
    current.matchedMessageCount = Number(row.matchedMessageCount);
    current.snippets.push({
      messageOrdinal: Number(row.messageOrdinal),
      role: row.role,
      timestamp: row.timestamp,
      text: row.text.replace(/\s+/g, ' ').trim(),
    });
    matches.set(row.chatId, current);
  }
  return matches;
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
  terms.forEach((term, index) => termInsert.run(index, term.query));
  termInsert.finalize();
  const resultStatement = db.prepare<ResultRow, [number, number]>(`
    SELECT chat_id AS chatId, SUM(best_rank) AS rank
    FROM temp_search_term_matches
    GROUP BY chat_id
    HAVING COUNT(*) = ?
    ORDER BY rank ASC, chat_id ASC
    LIMIT ?
  `);
  const resultRows = resultStatement.all(terms.length, clampLimit(options.limit));
  resultStatement.finalize();
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
