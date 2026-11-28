// Imports silent.ts without calling its exports.
import { expect, test } from 'bun:test';
import * as silent from './silent.js';

test('only looks at the module', () => {
  expect(Object.keys(silent)).toEqual(['answer']);
});
