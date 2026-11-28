import { test } from 'bun:test';
import type { ChatSearchQueryV1, ChatSearchTokenV1 } from '../../../../common/chat-search.ts';
import { validateSearchQuery } from './query-compiler-oracle.ts';

const token = (text: string, normalized = text.toLowerCase(), match: ChatSearchTokenV1['match'] = 'exact') =>
  ({ text, normalized, match });
const term = { kind: 'all-words', tokens: [token('Alpha', 'alpha', 'prefix'), token('beta')] } as const;

test('validates terms, token normalization and literal words in order', () => {
  const cases: ChatSearchQueryV1[] = [
    { version: 1, clauses: [term] },
    { version: 1, clauses: [] },
    { version: 1, clauses: [{ kind: 'phrase', tokens: [token('CAF\u00c9', 'cafe'), token('Σ', 'σ')] }] },
    { version: 1, clauses: [{ kind: 'literal', text: '#731', tokens: [token('731')] }] },
    { version: 1, clauses: [{ kind: 'literal', text: 'a\0b', tokens: [token('a'), token('b')] }] },
    { version: 1, clauses: [{ kind: 'literal', text: 'C++', tokens: [token('C', 'c')] }] },
    { version: 1, clauses: [{ kind: 'literal', text: '#732', tokens: [token('731')] }] },
    { version: 1, clauses: [{ kind: 'literal', text: '#731', tokens: [token('731', '731', 'prefix')] }] },
    { version: 1, clauses: [{ kind: 'literal', text: 'a', tokens: [token('', 'bad')] }] },
    { version: 1, clauses: [{ kind: 'phrase', tokens: [token('a b')] }] },
    { version: 1, clauses: [{ kind: 'phrase', tokens: [token('B', 'B')] }] },
    { version: 1, clauses: [{ kind: 'phrase', tokens: [] }] },
    { version: 1, clauses: Array(17).fill(term) },
    { version: 1, clauses: [{ kind: 'phrase', tokens: Array(33).fill(token('word')) }] },
  ];
  for (const query of cases) {
    try { validateSearchQuery(query); } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
});
