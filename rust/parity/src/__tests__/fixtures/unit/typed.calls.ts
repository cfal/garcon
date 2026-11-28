// Calls the exports of typed.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { half, labelOf, tagOf, total, triple } from './typed.js';

test('calls functions with typed arguments', () => {
  expect(tagOf('ab')).toBe('<ab>');
  expect(tagOf('a tag longer than eight')).toBe('-');
  expect(tagOf(3, 'none')).toBe('none');
  expect(total({ first: 1, second: 2 })).toBe(3);
  expect(triple(2)).toBe(6);
  // The tests themselves may pass what JSON cannot hold.
  expect(half(NaN)).toBeNaN();
  expect(half(4)).toBe(2);
  for (const text of ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh', 'ii', 'jj']) expect(labelOf(text)).toBe(`<${text}>`);
});
