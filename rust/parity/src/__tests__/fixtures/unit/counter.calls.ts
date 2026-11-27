// Calls the exports of counter.ts for the recorder test to capture.
import { expect, test } from 'bun:test';
import { next } from './counter.js';

test('calls a stateful export', () => {
  expect(next()).toBe(1);
  expect(next()).toBe(2);
});
