import { Database } from 'bun:sqlite';
import type { ChatSearchQueryV1 } from '../../../../common/chat-search.ts';
import { searchTranscriptIndexV1 } from '../../../../server-agents/common/src/search/query.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function acceptsTypedQuery(value: unknown): boolean {
  return record(value) && typeof value.version === 'number' && Number.isInteger(value.version)
    && value.version >= 0 && value.version <= 255 && Array.isArray(value.clauses)
    && value.clauses.every((clause: unknown) => record(clause)
      && (clause.kind === 'literal' && typeof clause.text === 'string'
        || clause.kind === 'phrase' || clause.kind === 'all-words')
      && Array.isArray(clause.tokens) && clause.tokens.every((token: unknown) => record(token)
        && typeof token.text === 'string' && typeof token.normalized === 'string'
        && (token.match === 'exact' || token.match === 'prefix')));
}

export function validateSearchQuery(query: ChatSearchQueryV1) {
  const db = new Database(':memory:');
  try {
    // A real query validates even an empty allowlist, without accessing index rows.
    searchTranscriptIndexV1(db, { query, allowedChats: [] });
    return true;
  } finally {
    db.close();
  }
}
