import { expect, test } from 'bun:test';
import { classifyGhError } from '../../../../server/runtime/gh/gh-error-classifier.js';

test('classifies raw diagnostic objects and keeps match precedence', () => {
  for (const [message, code] of [
    ['authentication failed: not found', 'AUTH_FAILED'],
    ['fatal: not a git repository', 'NOT_REPO'],
    ['HTTP 403 permissions', 'FORBIDDEN'],
    ['network is unreachable', 'NETWORK'],
    ['command not found: gh auth login', 'GH_MISSING'],
    ['', 'UNKNOWN'],
  ]) expect(classifyGhError({ message }).code).toBe(code);
  expect(classifyGhError()).toMatchObject({ code: 'UNKNOWN', message: 'GitHub CLI operation failed.' });
});
