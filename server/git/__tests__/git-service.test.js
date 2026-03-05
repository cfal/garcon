import { describe, it, expect } from 'bun:test';
import { GitDomainError } from '../git-types.js';
import { createGitService } from '../git-service.js';

// Minimal classifier stub for toHttpError tests
function mockClassifyGitError(error) {
  const msg = error?.message || '';
  if (msg.includes('hostname')) {
    return { code: 'NETWORK', status: 502, message: 'Could not reach the remote host.', details: 'Verify network access.' };
  }
  return { code: 'UNKNOWN', status: 500, message: msg || 'Git operation failed.' };
}

const mockProviders = {
  runSingleQuery: () => Promise.resolve('chore: stub'),
};

describe('GitDomainError', () => {
  it('extends Error with name and code', () => {
    const err = new GitDomainError('INVALID_INPUT', 'bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GitDomainError');
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toBe('bad input');
  });
});

describe('createGitService', () => {
  const git = createGitService({ providers: mockProviders, classifyGitError: mockClassifyGitError });

  it('returns an object with all expected service methods', () => {
    const expectedMethods = [
      'getStatus', 'getDiff', 'getFileWithDiff', 'initialCommit',
      'commit', 'getBranches', 'checkout', 'createBranch',
      'getCommits', 'getCommitDiff', 'generateCommitMessageForFiles',
      'getRemoteStatus', 'getRemotes', 'fetch', 'pull', 'push',
      'discard', 'deleteUntracked', 'getFileReviewData',
      'getChangesTree', 'stageSelection', 'stageHunk',
      'getWorktrees', 'createWorktree', 'removeWorktree',
      'commitIndex', 'stageFile', 'revertLastCommit', 'toHttpError',
    ];
    for (const method of expectedMethods) {
      expect(typeof git[method]).toBe('function');
    }
  });
});

describe('toHttpError', () => {
  const git = createGitService({ providers: mockProviders, classifyGitError: mockClassifyGitError });

  it('maps INVALID_INPUT GitDomainError to 400', async () => {
    const err = new GitDomainError('INVALID_INPUT', 'Missing field');
    const response = git.toHttpError(err);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Missing field');
  });

  it('maps NOT_REPO GitDomainError to 400', async () => {
    const err = new GitDomainError('NOT_REPO', 'Not a repo');
    const response = git.toHttpError(err);
    expect(response.status).toBe(400);
  });

  it('maps AUTH_FAILED GitDomainError to 401', async () => {
    const err = new GitDomainError('AUTH_FAILED', 'Auth failed');
    const response = git.toHttpError(err);
    expect(response.status).toBe(401);
  });

  it('maps unknown GitDomainError codes to 500', async () => {
    const err = new GitDomainError('SOME_OTHER', 'Other error');
    const response = git.toHttpError(err);
    expect(response.status).toBe(500);
  });

  it('maps commit message timeout domain code to 504 + typed errorCode', async () => {
    const err = new GitDomainError('COMMIT_MESSAGE_TIMEOUT', 'Timed out');
    const response = git.toHttpError(err);
    expect(response.status).toBe(504);
    const body = await response.json();
    expect(body.error).toBe('Timed out');
    expect(body.errorCode).toBe('commit_message_timeout');
  });

  it('delegates non-GitDomainError to classifier', async () => {
    const err = new Error('random failure');
    const response = git.toHttpError(err);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('random failure');
  });

  it('includes details from classifier when available', async () => {
    const err = new Error('Could not resolve hostname github.com');
    const response = git.toHttpError(err);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error).toBe('Could not reach the remote host.');
    expect(body.details).toBe('Verify network access.');
  });
});
