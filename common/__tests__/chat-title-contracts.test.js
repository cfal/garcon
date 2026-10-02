import { expect, test } from 'bun:test';
import { CHAT_TITLE_MAX_BYTES, fitDerivedChatTitle, parseUpdateChatTitleRequest } from '../chat-title-contracts.js';

test('chat title writes enforce a UTF-8 byte bound after trimming', () => {
  for (const title of ['a'.repeat(CHAT_TITLE_MAX_BYTES), '\u{1f600}'.repeat(CHAT_TITLE_MAX_BYTES / 4)]) {
    expect(parseUpdateChatTitleRequest({ chatId: 'synthetic', title: ` ${title} ` })).toEqual({ chatId: 'synthetic', title });
    expect(parseUpdateChatTitleRequest({ chatId: 'synthetic', title: `${title}x` })).toBeNull();
  }
  expect(parseUpdateChatTitleRequest({ chatId: 'synthetic', title: ' ' })).toBeNull();
});

test('derived titles reserve suffix bytes without splitting Unicode characters', () => {
  const title = fitDerivedChatTitle('\u{1f600}'.repeat(CHAT_TITLE_MAX_BYTES), ' (123)');
  expect(title.endsWith(' (123)')).toBe(true);
  expect(title.isWellFormed()).toBe(true);
  expect(Buffer.byteLength(title)).toBeLessThanOrEqual(CHAT_TITLE_MAX_BYTES);
});
