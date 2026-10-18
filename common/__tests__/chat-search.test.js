import { describe, expect, it } from 'bun:test';
import { parseChatSearch, serializeChatFilter } from '../chat-filter-query.ts';
import {
  CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS,
  classifyChatSearchFailureRecovery,
  compileChatSearchQuery,
  parseChatSearchResponse,
  parseTranscriptSearchRebuildResponse,
  parseTranscriptSearchStatusResponse,
} from '../chat-search.ts';

const request = {
  query: 'needle',
  mode: 'page',
  offset: 0,
  limit: 20,
  snippetLimit: 3,
};

function response() {
  return {
    query: 'needle',
    mode: 'page',
    snippetLimit: 3,
    results: [{
      chatId: '1785337200123456',
      transcriptViewId: 'view-1',
      score: 1.25,
      matchedMessageCount: 2,
      snippets: [{
        ordinal: 84,
        role: 'assistant',
        timestamp: '2026-09-07T00:00:00.000Z',
        text: 'the needle',
      }],
    }],
    page: { offset: 0, limit: 20, total: 1, hasMore: false, nextOffset: null },
    index: {
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 0,
      unindexedChatCount: 0,
      unsupportedChatCount: 0,
      resultsTruncated: false,
      failedChats: [],
      failedChatsOmittedCount: 0,
    },
    removedStaleResultCount: 0,
  };
}

describe('chat search contracts', () => {
  it('compiles exact phrases, prefix words, short exact words, and normalized tokens', () => {
    expect(compileChatSearchQuery('"version bump" v5 café')).toEqual({
      version: 1,
      clauses: [{
        kind: 'phrase',
        tokens: [
          { text: 'version', normalized: 'version', match: 'exact' },
          { text: 'bump', normalized: 'bump', match: 'exact' },
        ],
      }, {
        kind: 'all-words',
        tokens: [{ text: 'v5', normalized: 'v5', match: 'exact' }],
      }, {
        kind: 'all-words',
        tokens: [{ text: 'café', normalized: 'cafe', match: 'prefix' }],
      }],
    });
  });

  it('reconciles quoted raw terms with stripped web text tokens', () => {
    expect(compileChatSearchQuery('"root cause" status:active', ['root cause', 'needle']))
      .toEqual({
        version: 1,
        clauses: [{
          kind: 'phrase',
          tokens: [
            { text: 'root', normalized: 'root', match: 'exact' },
            { text: 'cause', normalized: 'cause', match: 'exact' },
          ],
        }, {
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'prefix' }],
        }],
      });
  });

  it('preserves punctuation-bearing identifiers for raw and web-token queries', () => {
    for (const text of ['#731', 'ABC-123', '/workspace/src/index.ts', 'file_name', 'C++', 'dev@example.test']) {
      for (const query of [text, `"${text}"`, `'${text}'`]) {
        const compiled = compileChatSearchQuery(query);
        expect(compiled.clauses[0]).toMatchObject({ kind: 'literal', text });
        expect(compiled.clauses[0].tokens.every((token) => token.match === 'exact')).toBe(true);
        expect(compileChatSearchQuery(query, [text])).toEqual(compiled);
      }
    }
    expect(compileChatSearchQuery('"PR #731"', ['PR #731']).clauses[0])
      .toMatchObject({ kind: 'literal', text: 'PR #731' });
    expect(compileChatSearchQuery('"PR\t#731"').clauses[0])
      .toMatchObject({ kind: 'literal', text: 'PR #731' });
    expect(compileChatSearchQuery('#731 marker').clauses.map((clause) => clause.kind))
      .toEqual(['literal', 'all-words']);
    expect(compileChatSearchQuery('731 cafe\u0301').clauses.map((clause) => clause.kind))
      .toEqual(['all-words', 'all-words']);
    expect(compileChatSearchQuery('###').clauses).toEqual([]);
  });

  it('recovers original literal spelling from normalized browser tokens', () => {
    for (const query of [
      '#K\u0130-123', '"#K\u0130-123"', '"PR #K\u0130-123"',
      'PR\u00a0#K\u0130-123', 'foo"#K\u0130-123"', '"PR #K\u0130-123', '#K\u0130-123"',
    ]) {
      const { textTokens } = parseChatSearch(query);
      const browser = compileChatSearchQuery(query, textTokens);
      const raw = compileChatSearchQuery(query);
      expect(browser.clauses.filter((clause) => clause.kind === 'literal'))
        .toEqual(raw.clauses.filter((clause) => clause.kind === 'literal'));
      expect(browser.clauses.some((clause) =>
        clause.kind === 'literal' && clause.text.includes('#K\u0130-123'))).toBe(true);
    }
  });

  it('retains supplied browser spelling for lexical prefixes', () => {
    const query = '\u1c90\u1c91\u1c92';
    expect(compileChatSearchQuery(query, parseChatSearch(query).textTokens).clauses).toEqual([{
      kind: 'all-words',
      tokens: [{ text: '\u10d0\u10d1\u10d2', normalized: '\u10d0\u10d1\u10d2', match: 'prefix' }],
    }]);
  });

  it('recovers repeated normalized tokens in their original order', () => {
    const query = 'ABC-123 abc-123';
    expect(compileChatSearchQuery(query, parseChatSearch(query).textTokens))
      .toEqual(compileChatSearchQuery(query));
  });

  it('does not recover literal spelling from metadata filter values', () => {
    const query = 'title:"synthetic #ki\u0307-123 label" #K\u0130-123';
    expect(compileChatSearchQuery(query, parseChatSearch(query).textTokens))
      .toEqual(compileChatSearchQuery('#K\u0130-123'));
  });

  it('keeps Unicode format characters lexical and asterisks literal', () => {
    for (const query of ['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', 'soft\u00adhyphen']) {
      const clause = compileChatSearchQuery(query).clauses[0];
      expect(clause.kind).toBe('all-words');
      expect(clause.tokens.some((token) => token.match === 'prefix')).toBe(true);
    }
    expect(compileChatSearchQuery('needle*').clauses[0])
      .toMatchObject({ kind: 'literal', text: 'needle*' });
  });

  it('separates all unquoted whitespace but retains quoted Unicode whitespace', () => {
    for (const whitespace of [' ', '\t', '\n', '\r\n', '\u00a0', '\u2003', '\u0085', '\ufeff']) {
      const query = `alpha${whitespace}beta`;
      const expected = compileChatSearchQuery('alpha beta');
      expect(compileChatSearchQuery(query)).toEqual(expected);
      expect(compileChatSearchQuery(query, parseChatSearch(query).textTokens)).toEqual(expected);
    }
    for (const whitespace of ['\u00a0', '\u0085', '\ufeff']) {
      const filter = parseChatSearch(`"alpha${whitespace}beta"`);
      expect(parseChatSearch(serializeChatFilter(filter))).toEqual(filter);
    }
  });

  it('parses a correlated search page and rejects malformed relations', () => {
    expect(parseChatSearchResponse(request, response())).toEqual(response());
    expect(() => parseChatSearchResponse(request, {
      ...response(),
      query: 'different',
    })).toThrow('query does not match request');
    expect(() => parseChatSearchResponse(request, {
      ...response(),
      page: { ...response().page, offset: 1 },
    })).toThrow('offset does not match request');
    expect(() => parseChatSearchResponse(request, {
      ...response(),
      results: [{ ...response().results[0], snippets: [{ ordinal: 0 }] }],
    })).toThrow('Invalid chat search response');
    expect(() => parseChatSearchResponse(request, {
      ...response(),
      page: { ...response().page, hasMore: true },
    })).toThrow('cursor presence');
    expect(() => parseChatSearchResponse(request, {
      ...response(),
      removedStaleResultCount: 20,
    })).toThrow('removed stale result count');
  });

  it('strictly validates bounded failed-chat details', () => {
    const failure = (index, overrides = {}) => ({
      chatId: String(1_785_337_200_000_000 + index),
      transcriptViewId: `view-${index}`,
      stage: 'indexing',
      errorCode: 'SEARCH_ROW_INVALID',
      indexedThroughOrdinal: 2,
      targetThroughOrdinal: 3,
      recovery: 'index-retry',
      ...overrides,
    });
    const failures = Array.from(
      { length: CHAT_SEARCH_MAX_FAILED_CHAT_DETAILS },
      (_, index) => failure(index),
    );
    const valid = response();
    valid.index = {
      ...valid.index,
      failedChatCount: failures.length + 5,
      failedChats: failures,
      failedChatsOmittedCount: 5,
    };
    expect(parseChatSearchResponse(request, valid).index).toEqual(valid.index);

    for (const failedChats of [
      [...failures, failure(21)],
      [failure(0), failure(0)],
      [failure(0, { stage: 'provider' })],
      [failure(0, { errorCode: 'not bounded' })],
      [failure(0, { indexedThroughOrdinal: 4 })],
      [failure(0, { recovery: 'retry-source' })],
    ]) {
      const invalid = response();
      invalid.index = {
        ...invalid.index,
        failedChatCount: failedChats.length,
        failedChats,
      };
      expect(() => parseChatSearchResponse(request, invalid))
        .toThrow('Invalid chat search response');
    }

    const countMismatch = response();
    countMismatch.index = {
      ...countMismatch.index,
      failedChatCount: 2,
      failedChats: [failure(0)],
      failedChatsOmittedCount: 0,
    };
    expect(() => parseChatSearchResponse(request, countMismatch))
      .toThrow('failed chat details');
  });

  it('strictly parses transcript search status and query statistics', () => {
    const status = {
      version: 1,
      phase: 'rebuilding',
      chats: { total: 3, indexed: 1, pending: 1, failed: 0, unindexed: 1 },
      queuedJobs: 2,
      resync: { completedChats: 1, totalChats: 3 },
      backlogRows: 7,
      activeChat: { position: 2, total: 5 },
      lastErrorCode: null,
      updatedAt: '2026-09-08T00:00:00.000Z',
      queryStats: {
        served: 4,
        timedOut: 1,
        rejectedBusy: 2,
        p50Ms: 10,
        p95Ms: 20,
        maxMs: 30,
        admissionP50Ms: 1,
        admissionP95Ms: 2,
        admissionMaxMs: 3,
        totalP50Ms: 11,
        totalP95Ms: 22,
        totalMaxMs: 33,
      },
    };
    expect(parseTranscriptSearchStatusResponse(status)).toEqual(status);

    for (const invalid of [
      { ...status, extra: true },
      { ...status, updatedAt: '2026-09-08' },
      { ...status, lastErrorCode: 'invalid code' },
      { ...status, chats: { ...status.chats, extra: 1 } },
      { ...status, resync: { completedChats: 4, totalChats: 3 } },
      { ...status, queryStats: { ...status.queryStats, served: -1 } },
      { ...status, queryStats: { ...status.queryStats, extra: 1 } },
    ]) expect(() => parseTranscriptSearchStatusResponse(invalid)).toThrow(
      'Invalid transcript search status response',
    );
  });

  it('strictly parses transcript search rebuild responses', () => {
    const status = {
      version: 1,
      phase: 'rebuilding',
      chats: { total: 0, indexed: 0, pending: 0, failed: 0, unindexed: 0 },
      queuedJobs: 0,
      resync: null,
      backlogRows: 0,
      activeChat: null,
      lastErrorCode: null,
      updatedAt: '2026-09-08T00:00:00.000Z',
      queryStats: {
        served: 0,
        timedOut: 0,
        rejectedBusy: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        admissionP50Ms: 0,
        admissionP95Ms: 0,
        admissionMaxMs: 0,
        totalP50Ms: 0,
        totalP95Ms: 0,
        totalMaxMs: 0,
      },
    };
    const response = { success: true, status };
    expect(parseTranscriptSearchRebuildResponse(response)).toEqual(response);
    for (const invalid of [
      { ...response, success: false },
      { ...response, extra: true },
      { ...response, status: { ...status, phase: 'unknown' } },
    ]) {
      expect(() => parseTranscriptSearchRebuildResponse(invalid))
        .toThrow('Invalid transcript search rebuild response');
    }
  });

  it('classifies failure recovery without treating source loss as an index retry', () => {
    expect(classifyChatSearchFailureRecovery('indexing', 'TRANSCRIPT_UNAVAILABLE'))
      .toBe('source-required');
    expect(classifyChatSearchFailureRecovery('ledger', 'SQLITE_CORRUPT'))
      .toBe('source-required');
    expect(classifyChatSearchFailureRecovery('indexing', 'SEARCH_ROW_INVALID'))
      .toBe('index-retry');
    expect(classifyChatSearchFailureRecovery('indexing', 'PROVIDER_FAILURE'))
      .toBe('unknown');
  });
});
