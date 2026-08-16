import { describe, expect, it } from 'bun:test';
import { isRelationallyValidTranscriptPage } from '../chat-view.ts';
import { AssistantMessage } from '../chat-types.ts';

const TS = '2026-08-16T00:00:00.000Z';

describe('transcript raw-page relations', () => {
  it('[TLV5-PAGE.09-CONTRACT-01] accepts an all-hidden page with an advancing raw continuation', () => {
    expect(isRelationallyValidTranscriptPage({
      messages: [],
      lastOrdinal: 300,
      pageOldestOrdinal: 0,
      pageNewestOrdinal: 250,
      nextBeforeOrdinal: 201,
      hasMore: true,
    })).toBe(true);
  });

  it('[TLV5-PAGE.10-CONTRACT-01] makes hasMore exactly equivalent to a raw continuation', () => {
    const base = {
      messages: [{ ordinal: 225, message: new AssistantMessage(TS, 'visible') }],
      lastOrdinal: 300,
      pageOldestOrdinal: 225,
      pageNewestOrdinal: 250,
    };

    expect(isRelationallyValidTranscriptPage({
      ...base,
      nextBeforeOrdinal: 201,
      hasMore: false,
    })).toBe(false);
    expect(isRelationallyValidTranscriptPage({
      ...base,
      nextBeforeOrdinal: null,
      hasMore: true,
    })).toBe(false);
    expect(isRelationallyValidTranscriptPage({
      ...base,
      nextBeforeOrdinal: 201,
      hasMore: true,
    })).toBe(true);
  });
});
