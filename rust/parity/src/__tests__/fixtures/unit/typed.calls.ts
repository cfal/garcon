// Calls the exports of typed.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { tagOf, total, triple } from './typed.js';

test('calls functions with typed arguments', () => {
  expect(tagOf('ab')).toBe('<ab>');
  expect(tagOf('a tag longer than eight')).toBe('-');
  expect(tagOf(3, 'none')).toBe('none');
  expect(total({ first: 1, second: 2 })).toBe(3);
  expect(triple(2)).toBe(6);
});
