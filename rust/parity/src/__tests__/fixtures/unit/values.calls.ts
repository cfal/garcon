// Calls the exports of values.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { LIMIT, SEPARATORS, VERSION, count, limited, versionLabel } from './values.js';

test('calls exports beside value exports', () => {
  expect(VERSION).toBe(3);
  expect(SEPARATORS.dot).toBe('.');
  expect(versionLabel()).toBe('v3');
  expect(limited(['a', 'b', 'c'])).toBe('a,b');
  expect(count(['a'])).toBe(0.5);
});
