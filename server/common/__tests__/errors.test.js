import { describe, expect, it } from 'bun:test';
import {
  diagnosticErrorCode,
  errorMessage,
} from '../errors.ts';

describe('errorMessage', () => {
  it('reads Error and structural error messages', () => {
    expect(errorMessage(new Error('native failure'))).toBe('native failure');
    expect(errorMessage({ message: 'structured failure' })).toBe('structured failure');
  });

  it('uses a caller fallback when no message is available', () => {
    expect(errorMessage({ code: 'FAILED' }, 'Operation failed.')).toBe('Operation failed.');
  });
});

describe('error codes', () => {
  it('falls back to an Error name for diagnostics', () => {
    expect(diagnosticErrorCode({ code: 'FAILED' })).toBe('FAILED');
    expect(diagnosticErrorCode(new TypeError('failed'))).toBe('TypeError');
    expect(diagnosticErrorCode('failed')).toBe('UNKNOWN');
  });
});
