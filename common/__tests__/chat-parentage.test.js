import { describe, expect, it } from 'bun:test';
import { chatLineagesEqual, parseChatLineage } from '../chat-parentage.ts';

const sourceChatId = '1783725900000200';

describe('chat lineage', () => {
  it('compares identity, kind and the complete watermark with nullable values', () => {
    const lineage = { sourceChatId, kind: 'fork', transcriptViewId: 'source-view', ordinal: 1 };
    expect(chatLineagesEqual(null, null)).toBe(true);
    expect(chatLineagesEqual(lineage, lineage)).toBe(true);
    expect(chatLineagesEqual(lineage, { ...lineage })).toBe(true);
    for (const other of [
      null,
      { ...lineage, sourceChatId: '1783725900000201' },
      { ...lineage, kind: 'handoff' },
      { ...lineage, transcriptViewId: 'other-view' },
      { ...lineage, ordinal: 2 },
    ]) {
      expect(chatLineagesEqual(lineage, other)).toBe(false);
      expect(chatLineagesEqual(other, lineage)).toBe(false);
    }
  });

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
