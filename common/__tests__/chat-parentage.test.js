import { describe, expect, it } from 'bun:test';
import { parseChatLineage } from '../chat-parentage.ts';

const sourceChatId = '1783725900000200';

describe('chat lineage', () => {
  it.each(['fork', 'handoff'])('parses and freezes %s provenance', (kind) => {
    const lineage = { sourceChatId, kind, transcriptViewId: 'source-view', ordinal: 0 };
    const parsed = parseChatLineage(lineage);
    expect(parsed).toEqual(lineage);
    expect(Object.isFrozen(parsed)).toBeTrue();
  });

  it('rejects incomplete, mixed, legacy and malformed references', () => {
    const valid = { sourceChatId, kind: 'fork', transcriptViewId: 'source-view', ordinal: 1 };
    for (const value of [undefined, null, [], 'source',
      { ...valid, sourceChatId: 'invalid' }, { ...valid, kind: 'delegation' },
      { ...valid, kind: 'merge' }, { sourceChatId, kind: 'fork' },
      { ...valid, transcriptViewId: '' }, { ...valid, transcriptViewId: null },
      { ...valid, ordinal: -1 }, { ...valid, ordinal: 1.5 },
      { ...valid, ordinal: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, extra: true },
      { chatId: sourceChatId, relation: 'fork', transcriptViewId: 'source-view', ordinal: 1 },
    ]) expect(parseChatLineage(value)).toBeNull();
  });
});
