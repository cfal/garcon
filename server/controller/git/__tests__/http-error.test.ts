import { expect, test } from 'bun:test';
import { gitHttpError } from '../http-error.js';
import { GitDomainError } from '../../../runtime/git/git-domain-error.js';
import { classifyGitError } from '../../../runtime/git/git-error-classifier.js';
import { COMMIT_MESSAGE_ERROR_MAP } from '../commit-message.js';

test('preserves commit generation status and public codes in the standard envelope', async () => {
  for (const [code, entry] of Object.entries(COMMIT_MESSAGE_ERROR_MAP)) {
    const response = gitHttpError(new GitDomainError(code, 'Synthetic failure'), classifyGitError);
    expect(response.status).toBe(entry.status);
    expect(await response.json()).toEqual({
      success: false, error: 'Synthetic failure', errorCode: entry.errorCode, retryable: entry.status >= 500,
    });
  }
});

test.each([
  ['INVALID_INPUT', 400], ['NOT_REPO', 400], ['AUTH_FAILED', 401], ['SERVICE_BUSY', 503], ['UNKNOWN', 500],
] as const)('preserves legacy %s status with explicit failure and retryability', async (code, status) => {
  const response = gitHttpError(new GitDomainError(code, 'Synthetic failure'), classifyGitError);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ success: false, errorCode: expect.any(String), retryable: status >= 500 });
});

test('preserves classifier details', async () => {
  const response = gitHttpError(new Error('permission denied'), classifyGitError);
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ success: false, details: 'Verify credentials or SSH key access.' });
});
