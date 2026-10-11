import { expect, test } from 'bun:test';
import { UserMessage, parseChatMessage } from '../chat-types.js';
import { isInputFormatByModel, isPlainTextInput, literalInputFormat } from '../input-format.js';

test('literal execution and durable Markdown presentation are independent', () => {
  const note = new UserMessage('2026-01-01T00:00:00Z', '**Synthetic note**', undefined, {
    contentMode: 'literal', contentFormat: 'markdown', clientMessageId: 'synthetic-input',
  });
  const decoded = parseChatMessage(JSON.parse(JSON.stringify(note)));
  expect(decoded).toEqual(note);
  expect(isPlainTextInput(decoded)).toBe(false);
  expect(isPlainTextInput(new UserMessage('', '**Command**', undefined, { contentMode: 'literal' }))).toBe(true);
  expect(isPlainTextInput(new UserMessage('', '**Conversation**'))).toBe(false);
});

test('format declarations are validated and only own model names override plain text', () => {
  expect(isInputFormatByModel({ notes: 'plain', markdown: 'markdown' })).toBe(true);
  for (const invalid of [null, [], { notes: 'html' }, { '': 'markdown' }]) expect(isInputFormatByModel(invalid)).toBe(false);
  expect(literalInputFormat({ markdown: 'markdown' }, 'markdown')).toBe('markdown');
  expect(literalInputFormat({}, 'constructor')).toBe('plain');
  expect(parseChatMessage({ type: 'user-message', content: 'note', metadata: { contentFormat: 'html' } }).metadata).toBeUndefined();
});
