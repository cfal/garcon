import { describe, it, expect } from 'bun:test';
import { classifyGitError } from '../git-error-classifier.js';

describe('classifyGitError', () => {
  it('classifies "not a git repository" as NOT_REPO with status 400', () => {
    const result = classifyGitError(new Error('fatal: not a git repository'));
    expect(result.code).toBe('NOT_REPO');
    expect(result.status).toBe(400);
    expect(result.message).toBe('Path is not a Git repository.');
  });

  it('classifies "git is not initialized" as NOT_REPO', () => {
    const result = classifyGitError(new Error('Git is not initialized in this directory.'));
    expect(result.code).toBe('NOT_REPO');
    expect(result.status).toBe(400);
  });

  it('classifies "permission denied" as AUTH_FAILED with status 401', () => {
    const result = classifyGitError(new Error('Permission denied (publickey).'));
    expect(result.code).toBe('AUTH_FAILED');
    expect(result.status).toBe(401);
    expect(result.message).toBe('Git authentication failed.');
  });

  it('classifies hostname resolution failure as NETWORK with status 502', () => {
    const result = classifyGitError(new Error('ssh: Could not resolve hostname github.com'));
    expect(result.code).toBe('NETWORK');
    expect(result.status).toBe(502);
  });

  it('classifies conflict errors as CONFLICT with status 409', () => {
    const result = classifyGitError(new Error('CONFLICT (content): Merge conflict in file.js'));
    expect(result.code).toBe('CONFLICT');
    expect(result.status).toBe(409);
  });

  it('classifies "nothing to commit" as NOTHING_TO_COMMIT with status 400', () => {
    const result = classifyGitError(new Error('nothing to commit, working tree clean'));
    expect(result.code).toBe('NOTHING_TO_COMMIT');
    expect(result.status).toBe(400);
  });

  it('classifies "nothing added" as NOTHING_TO_COMMIT', () => {
    const result = classifyGitError(new Error('nothing added to commit'));
    expect(result.code).toBe('NOTHING_TO_COMMIT');
    expect(result.status).toBe(400);
  });

  it('classifies missing remote as NO_REMOTE with status 500', () => {
    const result = classifyGitError(new Error("fatal: 'origin' does not appear to be a git repository"));
    expect(result.code).toBe('NO_REMOTE');
    expect(result.status).toBe(500);
    expect(result.details).toBeDefined();
  });

  it('classifies uncommitted changes as UNCOMMITTED_CHANGES with status 409', () => {
    const result = classifyGitError(new Error('error: Your local changes would be overwritten. Please commit your changes or stash them before you merge.'));
    expect(result.code).toBe('UNCOMMITTED_CHANGES');
    expect(result.status).toBe(409);
  });

  it('classifies diverged branches as DIVERGED with status 409', () => {
    const result = classifyGitError(new Error('Your branch and origin/main have diverged'));
    expect(result.code).toBe('DIVERGED');
    expect(result.status).toBe(409);
  });

  it('classifies no upstream branch as NO_UPSTREAM with status 400', () => {
    const result = classifyGitError(new Error('fatal: The current branch has no upstream branch'));
    expect(result.code).toBe('NO_UPSTREAM');
    expect(result.status).toBe(400);
  });

  it('classifies push rejection as REJECTED with status 409', () => {
    const result = classifyGitError(new Error('error: failed to push some refs, rejected'));
    expect(result.code).toBe('REJECTED');
    expect(result.status).toBe(409);
    expect(result.details).toBeDefined();
  });

  it('classifies non-fast-forward as REJECTED', () => {
    const result = classifyGitError(new Error('! [rejected] main -> main (non-fast-forward)'));
    expect(result.code).toBe('REJECTED');
    expect(result.status).toBe(409);
  });

  it('includes details field for classified errors when available', () => {
    const networkErr = classifyGitError(new Error('ssh: Could not resolve hostname github.com'));
    expect(networkErr.details).toBe('Verify network access and remote URL.');

    const authErr = classifyGitError(new Error('Permission denied (publickey).'));
    expect(authErr.details).toBe('Verify credentials or SSH key access.');

    const conflictErr = classifyGitError(new Error('CONFLICT (content): Merge conflict'));
    expect(conflictErr.details).toBe('Resolve conflicts, stage the fixes, then commit.');
  });

  it('classifies index.lock contention as GIT_LOCKED with status 409', () => {
    const result = classifyGitError(new Error('fatal: Unable to create \'/repo/.git/index.lock\': File exists.'));
    expect(result.code).toBe('GIT_LOCKED');
    expect(result.status).toBe(409);
    expect(result.message).toBe('Git index is locked by another process.');
    expect(result.details).toBeDefined();
  });

  it('classifies "index.lock" mention as GIT_LOCKED', () => {
    const result = classifyGitError(new Error('Another git process seems to be running in this repository, e.g. index.lock'));
    expect(result.code).toBe('GIT_LOCKED');
    expect(result.status).toBe(409);
  });

  it('classifies missing SSH as SSH_MISSING with status 502', () => {
    const result = classifyGitError(new Error('ssh: No such file or directory'));
    expect(result.code).toBe('SSH_MISSING');
    expect(result.status).toBe(502);
    expect(result.details).toBeDefined();
  });

  it('falls through to UNKNOWN for unrecognized errors', () => {
    const result = classifyGitError(new Error('something unexpected happened'));
    expect(result.code).toBe('UNKNOWN');
    expect(result.status).toBe(500);
    expect(result.message).toBe('something unexpected happened');
  });

  it('handles null/undefined error gracefully', () => {
    const result = classifyGitError(null);
    expect(result.code).toBe('UNKNOWN');
    expect(result.status).toBe(500);
    expect(result.message).toBe('Git operation failed.');
  });

  it('handles error without message property', () => {
    const result = classifyGitError({});
    expect(result.code).toBe('UNKNOWN');
    expect(result.status).toBe(500);
    expect(result.message).toBe('Git operation failed.');
  });
});
