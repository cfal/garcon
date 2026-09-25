import { describe, expect, it } from 'bun:test';
import { CHAT_MESSAGES_MAX_LIMIT, parsePagination } from '../pagination.ts';

describe('parsePagination', () => {
  it('defaults invalid values', () => {
    expect(parsePagination('not-a-number', Number.NaN, { maxLimit: CHAT_MESSAGES_MAX_LIMIT })).toEqual({
      limit: 20,
      offset: 0,
    });
  });

  it('clamps negative and oversized values', () => {
    expect(parsePagination('999999', '-25', { maxLimit: CHAT_MESSAGES_MAX_LIMIT })).toEqual({
      limit: CHAT_MESSAGES_MAX_LIMIT,
      offset: 0,
    });
  });

  it('truncates finite decimal values', () => {
    expect(parsePagination('7.9', 3.8, { maxLimit: CHAT_MESSAGES_MAX_LIMIT })).toEqual({
      limit: 7,
      offset: 3,
    });
  });
});
