import { describe, expect, it } from 'bun:test';
import {
  compileChatSearchQuery,
  parseChatSearchResponse,
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
    },
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

  it('parses a correlated search page and rejects malformed relations', () => {
    expect(parseChatSearchResponse(request, response())).toEqual(response());
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
  });
});
