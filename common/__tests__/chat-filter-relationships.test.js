import { describe, expect, it } from 'bun:test';
import { isEmptyFilter, matchesChatFilter, parseChatFilterQuery, serializeChatFilter } from '../chat-filter-query.ts';

const [child, parent, source] = ['1783725900000200', '1783725900000201', '1783725900000202'];
const chat = {
  id: child, parentChatId: parent, lineage: { sourceChatId: source, kind: 'fork', transcriptViewId: 'view', ordinal: 1 },
  title: 'Synthetic work', projectPath: '/synthetic', agentId: 'test', model: null, tags: [],
  isProcessing: false, isUnread: false, isPinned: false, isArchived: false, createdAt: null, lastActivityAt: null,
};

describe('independent relationship filters', () => {
  it('matches direct delegation and lineage independently with clause AND and value OR', () => {
    for (const [query, matches] of [
      [`parent:${parent}`, true], [`parent:${source}`, false], [`source:${source}`, true], [`source:${parent}`, false],
      [`parent:${parent} source:${source}`, true], [`source:${source}|${parent}`, true],
      [`source:${source} source:${parent}`, false], [`parent:${parent} parent:${source}`, false],
    ]) {
      const parsed = parseChatFilterQuery(query);
      expect(parsed.invalidTokens).toEqual([]);
      expect(isEmptyFilter(parsed.spec)).toBe(false);
      expect(matchesChatFilter(chat, parsed.spec)).toBe(matches);
      expect(parseChatFilterQuery(serializeChatFilter(parsed.spec)).spec).toEqual(parsed.spec);
    }
  });

  it('rejects invalid source IDs and does not infer one edge from the other', () => {
    expect(parseChatFilterQuery('source:title').invalidTokens).toEqual(['source:title']);
    expect(matchesChatFilter({ ...chat, parentChatId: null }, parseChatFilterQuery(`parent:${source}`).spec)).toBe(false);
    expect(matchesChatFilter({ ...chat, lineage: null }, parseChatFilterQuery(`source:${parent}`).spec)).toBe(false);
  });
});
