import { describe, expect, it } from 'bun:test';
import { isExpectedMissingGitResult } from '../comparison-errors.js';

describe('comparison git error classification', () => {
  it('treats only a normal exit-one miss as an absent revision or merge base', () => {
    expect(isExpectedMissingGitResult(Object.assign(new Error('missing'), { code: 1 }))).toBe(true);
    expect(isExpectedMissingGitResult(Object.assign(new Error('corrupt'), { code: 128 }))).toBe(false);
    expect(isExpectedMissingGitResult(Object.assign(new Error('timeout'), { code: 1, timedOut: true }))).toBe(false);
    expect(isExpectedMissingGitResult(Object.assign(new Error('aborted'), { code: 1, aborted: true }))).toBe(false);
    expect(isExpectedMissingGitResult(null)).toBe(false);
  });
});
