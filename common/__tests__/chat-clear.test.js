import { describe, expect, it } from 'bun:test';
import { parseClearChatRequest, parseClearChatResponse } from '../chat-clear.ts';

const request = { chatId: '1780000000000001', transcriptViewId: 'view-1', lastOrdinal: 9, target: { kind: 'all' } };

describe('clear chat request', () => {
  it('requires an explicit, bounded target without full-clear fallbacks', () => {
    expect(parseClearChatRequest({ ...request, target: { kind: 'before-message', ordinal: 4 } }).target)
      .toEqual({ kind: 'before-message', ordinal: 4 });
    for (const target of [undefined, null, {}, { kind: 'all', ordinal: 4 },
      ...[0, 10, -1, 1.5, '4'].map(ordinal => ({ kind: 'before-message', ordinal }))]) {
      expect(() => parseClearChatRequest({ ...request, target })).toThrow();
    }
  });
  it('requires a captured view and watermark', () => {
    expect(parseClearChatRequest(request)).toEqual(request);
    expect(parseClearChatRequest({ ...request, lastOrdinal: 0 }).lastOrdinal).toBe(0);
  });

  it.each([null, {}, { ...request, chatId: 'bad' }, { ...request, transcriptViewId: '' },
    ...[-1, 0.5, Infinity, '9', undefined].map((lastOrdinal) => ({ ...request, lastOrdinal })),
  ])('rejects malformed input %j', (value) => {
    expect(() => parseClearChatRequest(value)).toThrow();
  });
});

describe('clear chat response', () => {
  const response = { success: true, chatId: request.chatId, transcriptViewId: 'view-2' };
  it('validates the replacement identity', () => {
    expect(parseClearChatResponse(response)).toEqual(response);
  });
  it.each([null, {}, { ...response, success: false }, { ...response, chatId: 'bad' },
    { ...response, transcriptViewId: '' }, { ...response, transcriptViewId: ' ' },
  ])('rejects malformed replies %j', value => {
    expect(() => parseClearChatResponse(value)).toThrow();
  });
});
