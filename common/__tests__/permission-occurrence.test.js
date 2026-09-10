import { describe, expect, test } from 'bun:test';
import { isPermissionOccurrenceId } from '../permission-occurrence.js';
import { isExecutionIdentity, MAX_EXECUTION_IDENTITY_LENGTH } from '../execution-location.js';

describe('execution and permission identifier bounds', () => {
  test('accepts only canonical lowercase permission UUIDs with version and variant bits', () => {
    for (const variant of ['8', '9', 'a', 'b']) {
      expect(isPermissionOccurrenceId(`00000000-0000-4000-${variant}000-000000000001`)).toBeTrue();
    }
    for (const value of [null, 42, '', 'native-request-id', '00000000-0000-4000-0000-000000000001',
      '00000000-0000-1000-8000-000000000001', '00000000-0000-4000-8000-00000000000A']) {
      expect(isPermissionOccurrenceId(value)).toBeFalse();
    }
  });

  test('shares the exact maximum execution identity length with frame preflight', () => {
    expect(isExecutionIdentity('x'.repeat(MAX_EXECUTION_IDENTITY_LENGTH))).toBeTrue();
    expect(isExecutionIdentity('x'.repeat(MAX_EXECUTION_IDENTITY_LENGTH + 1))).toBeFalse();
    for (const value of ['', '_handle', 'handle.with.dot', 'handle space', 42]) {
      expect(isExecutionIdentity(value)).toBeFalse();
    }
  });
});
