import { describe, expect, test } from 'bun:test';
import { ERROR_CODES, isErrorCode } from '../../common/error-codes.ts';

// The subset relationships (CommandErrorCode / ClientRequestErrorCode) and the
// DomainError constructor are enforced against ERROR_CODES at compile time
// (Extract<ErrorCode, ...> and `code: ErrorCode`). These runtime checks guard the
// registry's own integrity and the narrowing helper.
describe('error code registry', () => {
  test('contains no duplicate codes', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test('isErrorCode accepts every registry member', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  test('isErrorCode rejects non-members and non-strings', () => {
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
  });
});
