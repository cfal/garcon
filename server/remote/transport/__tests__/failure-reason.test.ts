import { expect, test } from 'bun:test';
import { MALFORMED_DATA, failureReason } from '../failure-reason.js';

test('replaces a parse error, whose message can echo its payload', () => {
  let parseError: unknown;
  try { JSON.parse('{"synthetic": SYNTHETIC_SENTINEL}'); } catch (error) { parseError = error; }

  expect(parseError).toBeInstanceOf(SyntaxError);
  expect(failureReason(parseError)).toBe(MALFORMED_DATA);
});

test('keeps short messages and truncates long ones', () => {
  expect(failureReason(new Error('Executor connection lost'))).toBe('Executor connection lost');
  expect(failureReason(new Error('x'.repeat(250)))).toBe(`${'x'.repeat(200)}...`);
});

test('describes values that are not errors', () => {
  expect(failureReason('synthetic failure')).toBe('synthetic failure');
  expect(failureReason(42)).toBe('42');
});
