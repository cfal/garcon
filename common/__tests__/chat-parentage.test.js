import { describe, expect, it } from 'bun:test';

import {
  CHAT_PARENT_RELATIONS,
  isChatParentRelation,
  parseParentChatRef,
} from '../chat-parentage.ts';

const CHAT_ID = '1783725900000200';

describe('chat parentage', () => {
  it('parses and freezes transcript-sourced parent relations', () => {
    for (const relation of ['fork', 'handoff']) {
      const parsed = parseParentChatRef({
        chatId: CHAT_ID,
        relation,
        transcriptViewId: 'view-a',
        ordinal: 0,
      });

      expect(parsed).toEqual({
        chatId: CHAT_ID,
        relation,
        transcriptViewId: 'view-a',
        ordinal: 0,
      });
      expect(Object.isFrozen(parsed)).toBeTrue();
      expect(isChatParentRelation(relation)).toBeTrue();
    }
  });

  it('parses delegation without a transcript watermark', () => {
    const parsed = parseParentChatRef({
      chatId: CHAT_ID,
      relation: 'delegation',
      transcriptViewId: 'ignored-view',
      ordinal: 42,
    });

    expect(parsed).toEqual({ chatId: CHAT_ID, relation: 'delegation' });
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(CHAT_PARENT_RELATIONS).toContain('delegation');
    expect(isChatParentRelation('delegation')).toBeTrue();
  });

  it('rejects malformed parent references', () => {
    const valid = {
      chatId: CHAT_ID,
      relation: 'fork',
      transcriptViewId: 'view-a',
      ordinal: 1,
    };

    for (const value of [
      undefined,
      null,
      [],
      'parent',
      { ...valid, chatId: 'invalid' },
      { ...valid, relation: 'sub-agent' },
      { ...valid, relation: 'merge' },
      { chatId: CHAT_ID, relation: 'fork' },
      { chatId: CHAT_ID, relation: 'handoff' },
      { ...valid, transcriptViewId: '' },
      { ...valid, transcriptViewId: null },
      { ...valid, ordinal: -1 },
      { ...valid, ordinal: 1.5 },
      { ...valid, ordinal: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(parseParentChatRef(value)).toBeNull();
    }

    expect(isChatParentRelation('merge')).toBeFalse();
  });
});
