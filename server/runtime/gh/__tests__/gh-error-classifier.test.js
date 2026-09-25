import { describe, it, expect } from 'bun:test';
import { classifyGhError } from '../gh-error-classifier.js';

describe('classifyGhError', () => {
  it('classifies missing gh CLI as GH_MISSING with status 500', () => {
    const result = classifyGhError(new Error('GitHub CLI (gh) is not installed or not on PATH.'));
    expect(result.code).toBe('GH_MISSING');
    expect(result.status).toBe(500);
  });

  it('classifies auth errors as AUTH_FAILED with status 401', () => {
    const result = classifyGhError(new Error('gh: To get started with GitHub CLI, please run: gh auth login'));
    expect(result.code).toBe('AUTH_FAILED');
    expect(result.status).toBe(401);
  });

  it('classifies missing GitHub remote as NO_GITHUB_REMOTE with status 400', () => {
    const result = classifyGhError(new Error('none of the git remotes configured for this repository point to a known GitHub host'));
    expect(result.code).toBe('NO_GITHUB_REMOTE');
    expect(result.status).toBe(400);
  });

  it('classifies unknown PR as NOT_FOUND with status 404', () => {
    const result = classifyGhError(new Error('GraphQL: Could not resolve to a PullRequest with the number of 999.'));
    expect(result.code).toBe('NOT_FOUND');
    expect(result.status).toBe(404);
  });

  it('classifies rate limiting as RATE_LIMITED with status 429', () => {
    const result = classifyGhError(new Error('API rate limit exceeded for user.'));
    expect(result.code).toBe('RATE_LIMITED');
    expect(result.status).toBe(429);
  });

  it('falls back to UNKNOWN with status 500', () => {
    const result = classifyGhError(new Error('something unexpected happened'));
    expect(result.code).toBe('UNKNOWN');
    expect(result.status).toBe(500);
  });
});
