import { describe, it, expect } from 'bun:test';
import { deriveGhStatus } from '../gh-status.js';

describe('deriveGhStatus', () => {
  it('treats empty hosts as unauthenticated', () => {
    expect(deriveGhStatus({ hosts: {} })).toEqual({
      available: false,
      authenticated: false,
      reason: 'unauthenticated',
    });
  });

  it('returns available for an active successful account', () => {
    expect(
      deriveGhStatus({
        hosts: {
          'github.com': [{ active: true, state: 'success', login: 'octocat' }],
        },
      }),
    ).toEqual({
      available: true,
      authenticated: true,
      reason: 'authenticated',
      host: 'github.com',
      login: 'octocat',
    });
  });

  it('reports auth_error when active credentials are invalid', () => {
    expect(
      deriveGhStatus({
        hosts: {
          'github.com': [{ active: true, state: 'error', login: '' }],
        },
      }),
    ).toEqual({
      available: false,
      authenticated: false,
      reason: 'auth_error',
    });
  });

  it('ignores inactive successful accounts', () => {
    expect(
      deriveGhStatus({
        hosts: {
          'github.com': [{ active: false, state: 'success', login: 'octocat' }],
        },
      }),
    ).toEqual({
      available: false,
      authenticated: false,
      reason: 'unauthenticated',
    });
  });

  it('classifies missing gh binary errors', () => {
    expect(deriveGhStatus(null, new Error('GitHub CLI (gh) is not installed or not on PATH.'))).toEqual({
      available: false,
      authenticated: false,
      reason: 'gh_missing',
    });
  });

  it('fails closed for unknown errors', () => {
    expect(deriveGhStatus(null, new Error('malformed status output'))).toEqual({
      available: false,
      authenticated: false,
      reason: 'unknown',
    });
  });
});
