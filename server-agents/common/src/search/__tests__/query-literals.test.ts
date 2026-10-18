import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS, compileChatSearchQuery, type TranscriptSearchAllowedChat } from '@garcon/common/chat-search';
import { parseChatSearch } from '@garcon/common/chat-filter-query';
import { UserMessage } from '@garcon/common/chat-types';
import { projectSearchMessage } from '../message-projector.js';
import { SEARCH_QUERY_MATCH_ROW_LIMIT, searchTranscriptIndexV1 } from '../query.js';
import {
  finishChatSync,
  insertRowsBatch,
  openSearchDatabase,
  planChatSync,
  SEARCH_INGEST_TXN_MAX_ROWS,
} from '../schema.js';

let directory: string;
let db: Database;
let allowedChats: TranscriptSearchAllowedChat[];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'search-literals-'));
  db = (await openSearchDatabase(join(directory, 'index.sqlite'))).db;
  allowedChats = [];
});

afterEach(() => {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});

function addChat(chatId: string, bodies: string[]): void {
  const transcriptViewId = `view-${chatId}`;
  planChatSync(db, {
    mode: 'replace',
    chatId,
    transcriptViewId,
    targetThrough: bodies.length,
    expectedAfterOrdinal: 0,
  });
  for (let offset = 0; offset < bodies.length; offset += SEARCH_INGEST_TXN_MAX_ROWS) {
    const batch = bodies.slice(offset, offset + SEARCH_INGEST_TXN_MAX_ROWS);
    insertRowsBatch(db, {
      chatId,
      transcriptViewId,
      rows: batch.map((body, index) => ({
        ordinal: offset + index + 1,
        role: 'tool',
        timestamp: null,
        body,
      })),
      advanceTo: offset + batch.length,
    });
  }
  finishChatSync(db, { chatId, transcriptViewId });
  allowedChats.push({ chatId, transcriptViewId, throughOrdinal: bodies.length });
}

function search(query: string, offset = 0, limit = 20) {
  return searchTranscriptIndexV1(db, {
    query: compileChatSearchQuery(query),
    allowedChats,
    order: 'allowlist',
    offset,
    limit,
  });
}

describe('literal identifier search', () => {
  test('rejects numeric noise and longer identifiers, quoted or unquoted', () => {
    addChat('wanted', ['Review #731.']);
    addChat('adjacent', ['Review PR#731.']);
    addChat('noise', ['731: synthetic source line', '00:00:00.731Z', '731123 numeric identifier']);
    addChat('longer', ['Review #7310 and #731suffix and #731_suffix.']);
    for (const query of ['#731', '"#731"', "'#731'"]) {
      const result = search(query);
      expect(result.results.map((entry) => entry.chatId)).toEqual(['wanted', 'adjacent']);
      expect(result.page.total).toBe(2);
      expect(result.results.every((entry) => entry.matchedMessageCount === 1)).toBe(true);
      expect(result.results.every((entry) => entry.snippets[0]!.text.includes('#731'))).toBe(true);
    }
    expect(search('731').page.total).toBe(4);
    expect(search('"731"').page.total).toBe(4);
  });

  test('retains exact FTS candidates when newer symbols or private-use glyphs join an identifier', () => {
    addChat('separated', ['#731.']);
    for (const [index, suffix] of ['\u{1f914}', '\u{1fae1}', '\u20bf', '\ue0a0'].entries()) {
      addChat(`attached-${index}`, [`#731${suffix}`]);
    }
    for (const query of ['#731', '"#731"']) {
      const result = search(query);
      expect(result.results.map((hit) => hit.chatId)).toEqual(['separated']);
      expect(result.index.resultsTruncated).toBe(false);
    }
  });

  test.each([
    { query: 'ABC-123', body: 'abc-123', decoy: 'ABC 123', longer: 'ABC-123suffix' },
    { query: '/workspace/src/index.ts', body: '/WORKSPACE/src/index.ts', decoy: '/workspace/src/index ts', longer: '/workspace/src/index.tsx' },
    { query: 'C:\\workspace\\index.ts', body: 'C:\\workspace\\index.ts', decoy: 'C workspace index ts', longer: 'C:\\workspace\\index.tsx' },
    { query: 'file_name', body: 'file_name', decoy: 'file name', longer: 'file_names' },
    { query: 'C++', body: 'C++', decoy: 'C', longer: 'XC++' },
    { query: 'dev@example.test', body: 'DEV@example.test', decoy: 'dev example test', longer: 'otherdev@example.test' },
    { query: 'x.y[1]', body: 'x.y[1]', decoy: 'xay 1', longer: 'ax.y[1]' },
    { query: '"PR #731"', body: 'PR #731', decoy: 'PR 731', longer: 'PR #7310' },
  ])('preserves literal punctuation in $query', ({ query, body, decoy, longer }) => {
    addChat('wanted', [body]);
    addChat('decoy', [decoy]);
    addChat('longer', [longer]);
    expect(search(query).results.map((entry) => entry.chatId)).toEqual(['wanted']);
    expect(search(query).results[0]!.snippets[0]!.text).toBe(body);
  });

  test('filters before paging, chat-scope intersection, counts, and snippet selection', () => {
    addChat('noise-first', ['731 marker']);
    addChat('wanted-first', ['731 decoy before the real match', '#731', 'marker']);
    addChat('wrong-clause', ['#731']);
    addChat('wanted-last', ['#731 marker']);
    const first = search('#731 marker', 0, 1);
    expect(first.results.map((entry) => entry.chatId)).toEqual(['wanted-first']);
    expect(first.page).toEqual({ offset: 0, limit: 1, total: 2, hasMore: true, nextOffset: 1 });
    expect(first.results[0]!.matchedMessageCount).toBe(2);
    expect(first.results[0]!.snippets.map((snippet) => snippet.ordinal)).toEqual([2, 3]);
    const last = search('#731 marker', 1, 1);
    expect(last.results.map((entry) => entry.chatId)).toEqual(['wanted-last']);
    expect(last.page).toEqual({ offset: 1, limit: 1, total: 2, hasMore: false, nextOffset: null });
  });

  test('anchors snippets at the literal occurrence rather than an earlier numeric decoy', () => {
    addChat('wanted', [`731 ${'synthetic context '.repeat(40)}#731.`]);
    const snippet = search('#731').results[0]!.snippets[0]!;
    expect(snippet.text).toContain('#731');
    expect(snippet.text).toStartWith('... ');
    addChat('leading', ['#731.']);
    expect(search('#731').results[1]!.snippets[0]!.text).toBe('#731.');
  });

  test('anchors mixed-clause snippets on the verified literal rather than an earlier word', () => {
    addChat('wanted', [`marker ${'synthetic context '.repeat(100)}#731 useful trailing explanation`]);
    const result = searchTranscriptIndexV1(db, {
      query: compileChatSearchQuery('marker #731'), allowedChats, snippetLimit: 1,
    });
    expect(result.results[0]!.snippets).toHaveLength(1);
    expect(result.results[0]!.snippets[0]!.text).toContain('#731');
  });

  test.each(['needle', '#731'])(
    'retains trailing context after %s with a long punctuation prefix', (query) => {
      addChat('wanted', [`${'='.repeat(600)} ${query} useful trailing explanation`]);
      const snippet = search(query).results[0]!.snippets[0]!.text;
      expect(snippet).toContain(`${query} useful trailing explanation`);
      expect([...snippet].length).toBeLessThanOrEqual(CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS);
    },
  );

  test('retains browser lexical case folding without changing literal spelling recovery', () => {
    addChat('wanted', [projectSearchMessage(new UserMessage('', '\u10d0\u10d1\u10d2\u10d3\u10d0'))!.body]);
    const query = '\u1c90\u1c91\u1c92';
    const result = searchTranscriptIndexV1(db, {
      query: compileChatSearchQuery(query, parseChatSearch(query).textTokens), allowedChats,
    });
    expect(result.results.map((hit) => hit.chatId)).toEqual(['wanted']);
    expect(result.index.resultsTruncated).toBe(false);
  });

  test.each(['#731', 'needle', '/workspace/src/index.ts', 'C++'])(
    'keeps %s visible after long punctuation or word context', (query) => {
      addChat('punctuation', [`${'='.repeat(600)}${query}.`]);
      addChat('long-word', [`${'context'.repeat(100)} ${query}.`]);
      const result = search(query);
      expect(result.page.total).toBe(2);
      for (const hit of result.results) {
        expect(hit.snippets[0]!.text).toContain(query);
        expect([...hit.snippets[0]!.text].length).toBeLessThanOrEqual(CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS);
      }
    },
  );

  test('preserves original Unicode literals from actual browser parsing', () => {
    const query = '#K\u0130-123';
    addChat('wanted', [query]);
    const result = searchTranscriptIndexV1(db, {
      query: compileChatSearchQuery(query, parseChatSearch(query).textTokens),
      allowedChats,
    });
    expect(result.results.map((hit) => hit.chatId)).toEqual(['wanted']);
  });

  test.each([
    ['PR\u00a0#K\u0130-123', 'PR #K\u0130-123'],
    ['foo"#K\u0130-123"', 'foo #K\u0130-123'],
    ['"PR #K\u0130-123', 'PR #K\u0130-123'],
    ['#K\u0130-123"', '#K\u0130-123'],
    ['title:"synthetic #ki\u0307-123 label" #K\u0130-123', '#K\u0130-123'],
  ])('preserves browser literal spelling for %s', (query, body) => {
    const projected = projectSearchMessage(new UserMessage('', body))!;
    addChat('wanted', [projected.body]);
    const result = searchTranscriptIndexV1(db, {
      query: compileChatSearchQuery(query, parseChatSearch(query).textTokens),
      allowedChats,
    });
    expect(result.results.map((hit) => hit.chatId)).toEqual(['wanted']);
    expect(result.index.resultsTruncated).toBe(false);
  });

  test.each(['- needle in a list item', '# Heading needle', '(#731) fixed'])(
    'retains short leading punctuation in %s', (body) => {
      addChat('wanted', [body]);
      expect(search(body.includes('needle') ? 'needle' : '#731').results[0]!.snippets[0]!.text)
        .toBe(body);
    },
  );

  test('keeps NUL literal verification without passing NUL to FTS syntax', () => {
    const query = 'foo\u0000bar';
    addChat('wanted', [projectSearchMessage(new UserMessage('', query))!.body]);
    addChat('decoy', ['foo bar']);
    expect(search(query).results.map((hit) => hit.chatId)).toEqual(['wanted']);
    expect(search('bar').page.total).toBe(2);
  });

  test('keeps format characters lexical rather than requiring their exact spelling', () => {
    addChat('spaced', ['\u0645\u06cc \u062e\u0648\u0627\u0647\u0645 soft hyphens']);
    for (const query of ['\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645', 'soft\u00adhyphen']) {
      expect(search(query).results.map((hit) => hit.chatId)).toEqual(['spaced']);
    }
  });

  test('keeps asterisks literal and supports apostrophes inside double-quoted phrases', () => {
    addChat('wanted', ["needle* don't stop user's config"]);
    addChat('decoy', ['needle needles stop config']);
    for (const query of ['needle*', '"don\'t stop"', '"user\'s config"']) {
      expect(search(query).results.map((hit) => hit.chatId)).toEqual(['wanted']);
    }
  });

  test.each(['"type":"tool_use"', '{"type":"tool_use"}', 'key:"value"'])(
    'finds the original quoted fragment %s on raw and browser paths', (query) => {
      addChat('wanted', [projectSearchMessage(new UserMessage('', query))!.body]);
      for (const textTokens of [undefined, parseChatSearch(query).textTokens]) {
        const result = searchTranscriptIndexV1(db, {
          query: compileChatSearchQuery(query, textTokens), allowedChats,
        });
        expect(result.results.map((hit) => hit.chatId)).toEqual(['wanted']);
        expect(result.index.resultsTruncated).toBe(false);
      }
    },
  );

  test.each([
    { query: 'class="banner"', decoy: ['class= is set elsewhere', 'the banner text'] },
    { query: 'API_MODE="safe mode"', decoy: ['API_MODE= unset', 'enter safe mode now'] },
    { query: '"type":"tool_use"', decoy: ['{"type":"text"}', '{"kind":"tool_use"}'] },
    { query: '{"type":"tool_use"}', decoy: ['{"type":"text"}', '{"kind":"tool_use"}'] },
  ])('keeps shared quote delimiters in $query and supports an enclosing literal phrase', ({ query, decoy }) => {
    addChat('wanted', [projectSearchMessage(new UserMessage('', query))!.body]);
    addChat('split', decoy.map((body) => projectSearchMessage(new UserMessage('', body))!.body));
    for (const text of [query, `'${query}'`]) {
      for (const textTokens of [undefined, parseChatSearch(text).textTokens]) {
        const result = searchTranscriptIndexV1(db, {
          query: compileChatSearchQuery(text, textTokens), allowedChats, order: 'allowlist',
        });
        expect(result.results.map((hit) => hit.chatId))
          .toEqual(text === query ? ['wanted', 'split'] : ['wanted']);
        expect(result.index.resultsTruncated).toBe(false);
      }
    }
  });

  test.each(['\n', '\u00a0', '\u2003', '\u0085'])(
    'keeps unquoted %s-separated prefixes independent across messages', (whitespace) => {
      addChat('wanted', ['alphabet', 'betamax']);
      const query = `alpha${whitespace}beta`;
      for (const textTokens of [undefined, parseChatSearch(query).textTokens]) {
        const result = searchTranscriptIndexV1(db, {
          query: compileChatSearchQuery(query, textTokens), allowedChats,
        });
        expect(result.results.map((hit) => hit.chatId)).toEqual(['wanted']);
      }
    },
  );

  test('normalizes Unicode whitespace in literal phrases without requiring an index rebuild', () => {
    addChat('nel', [projectSearchMessage(new UserMessage('', 'PR\u0085#731'))!.body]);
    addChat('space', [projectSearchMessage(new UserMessage('', 'PR #731'))!.body]);
    for (const query of ['"PR\u0085#731"', '"PR #731"']) {
      for (const textTokens of [undefined, parseChatSearch(query).textTokens]) {
        const result = searchTranscriptIndexV1(db, {
          query: compileChatSearchQuery(query, textTokens), allowedChats, order: 'allowlist',
        });
        expect(result.results.map((hit) => hit.chatId)).toEqual(['nel', 'space']);
      }
    }
  });

  test('keeps verified literals and trailing context visible across long Unicode whitespace runs', () => {
    addChat('wanted', [projectSearchMessage(new UserMessage(
      '', `PR${'\u0085'.repeat(600)}#731 useful trailing explanation`,
    ))!.body]);
    const snippet = search('"PR #731"').results[0]!.snippets[0]!.text;
    expect(snippet).toContain('PR #731 useful trailing explanation');
    expect([...snippet].length).toBeLessThanOrEqual(CHAT_SEARCH_MAX_SNIPPET_CODE_POINTS);
  });

  test.each(['\ud800', '\udc00'])(
    'keeps unpaired surrogate %j out of FTS syntax without changing literal verification', (surrogate) => {
      addChat('wanted', ['foo bar #731']);
      for (const query of [`foo${surrogate}bar`, `#731${surrogate}`]) {
        expect(search(query).results).toEqual([]);
      }
      expect(search('#731').results.map((hit) => hit.chatId)).toEqual(['wanted']);
    },
  );

  test('keeps internal combining marks intact in literal FTS candidates', () => {
    const query = '/workspace/Cafe\u0301x/file.ts';
    addChat('wanted', [query]);
    expect(search(query).results.map((hit) => hit.chatId)).toEqual(['wanted']);
  });

  test('enforces identifier boundaries at combining marks', () => {
    addChat('wanted', ['#cafe\u0301']);
    addChat('suffix', ['#cafe\u0301_suffix']);
    addChat('prefix', ['prefix\u0301cafe#']);
    addChat('leading', ['\u0301cafe#']);
    expect(search('#cafe\u0301').results.map((hit) => hit.chatId)).toEqual(['wanted']);
    expect(search('\u0301cafe#').results.map((hit) => hit.chatId)).toEqual(['leading']);
  });

  test('matches normalized production whitespace in quoted literals', () => {
    for (const [index, whitespace] of [' ', '  ', '\n', '\t', '\u00a0'].entries()) {
      const projected = projectSearchMessage(new UserMessage('', `PR${whitespace}#731`));
      expect(projected?.body).toBe('PR #731');
      addChat(`whitespace-${index}`, [projected!.body]);
    }
    for (const whitespace of [' ', '  ', '\n', '\t', '\u00a0']) {
      expect(search(`"PR${whitespace}#731"`).page.total).toBe(5);
    }
  });

  test('keeps prose punctuation and accent spelling significant in literal queries', () => {
    addChat('ascii', ["don't TypeError: failing? /workspace/Caf\u00e9/a.ts"]);
    addChat('other-spelling', ['don\u2019t TypeError failing /workspace/Cafe\u0301/a.ts']);
    for (const query of ["don't", 'TypeError:', 'failing?', '/workspace/Caf\u00e9/a.ts']) {
      expect(search(query).results.map((hit) => hit.chatId)).toEqual(['ascii']);
    }
    expect(search('/workspace/Cafe\u0301/a.ts').results.map((hit) => hit.chatId))
      .toEqual(['other-spelling']);
  });

  test('keeps sampling truthful when literal candidates exceed the row ceiling', () => {
    addChat('sampled', [
      '#731',
      ...Array.from({ length: SEARCH_QUERY_MATCH_ROW_LIMIT }, () => '731: synthetic source line'),
    ]);
    const sampled = search('#731');
    expect(sampled.results).toEqual([]);
    expect(sampled.page.total).toBe(0);
    expect(sampled.index.resultsTruncated).toBe(true);
    expect(search('"731"').results[0]!.matchedMessageCount).toBe(SEARCH_QUERY_MATCH_ROW_LIMIT);
  });

  test('keeps current-view frontiers and allowlists authoritative for literal results', () => {
    addChat('wanted', ['731', '#731']);
    addChat('excluded', ['#731']);
    allowedChats = [{ ...allowedChats[0]!, throughOrdinal: 1 }];
    expect(search('#731').results).toEqual([]);
    allowedChats[0] = { ...allowedChats[0]!, throughOrdinal: 2 };
    expect(search('#731').results.map((entry) => entry.chatId)).toEqual(['wanted']);
    allowedChats[0] = { ...allowedChats[0]!, transcriptViewId: 'stale-view' };
    expect(search('#731').results).toEqual([]);
  });

  test('rejects literal clauses whose candidate tokens do not describe their text', () => {
    const query = compileChatSearchQuery('#731');
    expect(() => searchTranscriptIndexV1(db, {
      allowedChats,
      query: {
        ...query,
        clauses: [{
          kind: 'literal', text: '#732', tokens: query.clauses[0]!.tokens,
        }],
      },
    })).toThrow('Transcript search literal is invalid');
  });
});
