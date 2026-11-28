import { compileChatSearchQuery, type TranscriptSearchAllowedChat } from '../../../../common/chat-search.ts';
import { searchTranscriptIndexV1, SEARCH_QUERY_MATCH_ROW_LIMIT } from '../../../../server-agents/common/src/search/query.ts';
import type { HistoricalSearchMessageRow } from '../../../../server-agents/common/src/search/rows.ts';
import { openSearchReadDatabase } from '../../../../server-agents/common/src/search/schema.ts';
import { MAX_ROWS_PER_FRAME } from '../../../../server-agents/common/src/search/worker-protocol.ts';

const allowed = (chatId: string, transcriptViewId: string, throughOrdinal: number): TranscriptSearchAllowedChat => ({
  chatId, transcriptViewId, throughOrdinal,
});
const literal = allowed('literal', 'literal-view', 3);
const noise = allowed('noise', 'noise-view', 1);
const broad = allowed('broad', 'broad-view', SEARCH_QUERY_MATCH_ROW_LIMIT + 2);
const alpha = allowed('alpha', 'new', 3);
const bravo = allowed('bravo', 'bravo-view', 9);
const stale = allowed('alpha', 'old', 6);
const sparse = allowed('sparse', 'sparse-view', 5);
const failure = allowed('failure', 'failure-view', 3);
const absent = allowed('absent', 'absent-view', 1);
const retired = allowed('retired', 'retired-view', 1);
const selected = [bravo, literal, alpha, noise, sparse, failure, absent, retired];

function row(ordinal: number, body: string, role: HistoricalSearchMessageRow['role'] = 'tool'): HistoricalSearchMessageRow {
  return { ordinal, role, body, timestamp: ordinal === 1 ? null : '2026-01-01T00:00:00.000Z' };
}

export function queryActions() {
  return [
    ...[{
      entry: literal,
      rows: [
        row(1, `731 decoy ${'synthetic context '.repeat(40)}#731.\u0085then\uFEFFmore \u{1f469}\u200d\u{1f4bb}`),
        row(2, 'abc-123 checked\u00a0CAF\u00c9', 'user'),
        row(3, `quartz ${'remarkable '.repeat(130)}marker`, 'system'),
      ],
    }, {
      entry: noise,
      rows: [row(1, '731 synthetic without hash ABC 123 marker', 'assistant')],
    }].map(({ entry, rows }) => ({
      kind: 'build' as const,
      chatId: entry.chatId,
      transcriptViewId: entry.transcriptViewId,
      targetThrough: entry.throughOrdinal,
      expectedAfterOrdinal: 0,
      mode: 'replace' as const,
      advanceTo: entry.throughOrdinal,
      rows,
      finish: true,
    })),
    ...Array.from({ length: Math.ceil(broad.throughOrdinal / MAX_ROWS_PER_FRAME) }, (_, batch) => {
      const offset = batch * MAX_ROWS_PER_FRAME;
      const end = Math.min(broad.throughOrdinal, offset + MAX_ROWS_PER_FRAME);
      return {
        kind: 'build' as const,
        chatId: broad.chatId,
        transcriptViewId: broad.transcriptViewId,
        targetThrough: end,
        expectedAfterOrdinal: offset,
        mode: offset ? 'append' as const : 'replace' as const,
        advanceTo: end,
        rows: Array.from({ length: end - offset }, (_, i) => row(offset + i + 1,
          offset + i === 0 ? '#731 needle anchor-only' : '731 needle synthetic sample')),
        finish: true,
      };
    }),
  ];
}

type Query = Omit<Parameters<typeof searchTranscriptIndexV1>[1], 'query'> & {
  name: string; text: string;
};

export const queries = [
  { name: 'ranked', text: 'quartz', allowedChats: selected, limit: 2, snippetLimit: 2 },
  { name: 'next-page', text: 'quartz', allowedChats: selected, limit: 2, offset: 2 },
  { name: 'allowlist-order', text: 'quartz', allowedChats: selected, order: 'allowlist', limit: 2 },
  { name: 'bounded-prefix', text: 'quar', allowedChats: selected, mode: 'prefix', snippetLimit: 1, limit: 1 },
  { name: 'literal-asterisk', text: 'quar*', allowedChats: selected },
  { name: 'clamped-page', text: 'quartz', allowedChats: selected, limit: 0, offset: 2.5, snippetLimit: 8 },
  { name: 'literal-boundaries', text: '#731', allowedChats: selected },
  { name: 'literal-and-cross-row-term', text: '#731 marker', allowedChats: selected },
  { name: 'punctuation', text: 'ABC-123', allowedChats: selected },
  { name: 'diacritics', text: 'cafe', allowedChats: selected },
  { name: 'frontier', text: 'quartz', allowedChats: [{ ...literal, throughOrdinal: 2 }, alpha] },
  { name: 'view-mismatch', text: 'quartz', allowedChats: [stale, sparse, failure, absent, retired] },
  { name: 'trim-deduplicate', text: 'quartz', allowedChats: [alpha, { ...alpha, chatId: ' alpha ' }] },
  { name: 'empty', text: 'quartz', allowedChats: [], offset: 3 },
  { name: 'after-empty', text: 'quartz', allowedChats: [alpha] },
  { name: 'bad-prefix-offset', text: 'quartz', mode: 'prefix', allowedChats: selected, snippetLimit: 2, offset: 1 },
  { name: 'bad-prefix-limit', text: 'quartz', mode: 'prefix', allowedChats: selected, snippetLimit: 2 },
  { name: 'contradictory', text: 'quartz', allowedChats: [alpha, stale] },
  { name: 'bad-frontier', text: 'quartz', allowedChats: [{ ...alpha, throughOrdinal: Number.MAX_SAFE_INTEGER + 1 }] },
  { name: 'sample-before-literal', text: '#731', allowedChats: [broad] },
  { name: 'sample-latest', text: 'needle', allowedChats: [broad], snippetLimit: 1 },
  { name: 'exact-after-sampling', text: 'anchor-only', allowedChats: [broad] },
] satisfies Query[];

export function queryIndex(path: string) {
  const db = openSearchReadDatabase(path);
  try {
    return queries.map(({ name, text, ...options }) => {
      try {
        return { name, result: searchTranscriptIndexV1(db, { ...options, query: compileChatSearchQuery(text) }) };
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        return { name, error: error.message };
      }
    });
  } finally {
    db.close();
  }
}
