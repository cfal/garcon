// A test file that fails on its own.
import { expect, test } from 'bun:test';
import { join } from './functions.js';

test('fails', () => {
  expect(join(['a', 'b'])).toBe('a;b');
});
