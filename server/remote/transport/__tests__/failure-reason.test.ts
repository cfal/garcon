import { expect, test } from 'bun:test';
import { MALFORMED_DATA, failureReason } from '../failure-reason.js';

// Bun's stack for a parse error: native frames, then the nearest caller it kept.
function parseErrorWithFrames(...frames: string[]): SyntaxError {
  const parseError = new SyntaxError('JSON Parse error: Unexpected identifier "SYNTHETIC_SENTINEL"');
  parseError.stack = [String(parseError), '    at <parse> (:0)', '    at parse (unknown)', ...frames].join('\n');
  return parseError;
}

test('replaces a parse error, whose message can echo its payload, with where it was thrown', () => {
  let parseError: unknown;
  try { JSON.parse('{"synthetic": SYNTHETIC_SENTINEL}'); } catch (error) { parseError = error; }

  expect(parseError).toBeInstanceOf(SyntaxError);
  expect(failureReason(parseError)).toStartWith(MALFORMED_DATA);
  expect(failureReason(parseError)).not.toContain('SYNTHETIC_SENTINEL');
  expect(failureReason(parseErrorWithFrames('    at async load (/synthetic/loader.ts:12:34)')))
    .toBe('Malformed data at async load (/synthetic/loader.ts:12:34)');
});

test('reads the location from the stack frames, not from a message that imitates them', () => {
  const parseError = new SyntaxError('SYNTHETIC_SENTINEL\n    at synthetic (/synthetic/sentinel.ts:1:1)');
  parseError.stack = `${parseError}\n    at <parse> (:0)\n    at /synthetic/caller.ts:3:7`;

  expect(failureReason(parseError)).toBe('Malformed data at /synthetic/caller.ts:3:7');
});

test('describes a parse error without a source position as malformed data', () => {
  expect(failureReason(parseErrorWithFrames())).toBe(MALFORMED_DATA);
});

test('keeps short messages and truncates long ones', () => {
  expect(failureReason(new Error('Executor connection lost'))).toBe('Executor connection lost');
  expect(failureReason(new Error('x'.repeat(250)))).toBe(`${'x'.repeat(200)}...`);
});

test('describes values that are not errors', () => {
  expect(failureReason('synthetic failure')).toBe('synthetic failure');
  expect(failureReason(42)).toBe('42');
});
