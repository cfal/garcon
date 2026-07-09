import type { GhStatusResponse } from '../../common/gh.js';
import { classifyGhError } from './gh-error-classifier.js';

export interface GhAuthAccount {
  state?: string;
  active?: boolean;
  host?: string;
  login?: string;
}

export interface GhAuthStatusJson {
  hosts?: Record<string, GhAuthAccount[] | undefined>;
}

function isAuthenticatedAccount(account: GhAuthAccount): boolean {
  return account.active === true && account.state === 'success';
}

function hasAuthError(raw: GhAuthStatusJson): boolean {
  return Object.values(raw.hosts ?? {}).some((accounts) =>
    (accounts ?? []).some((account) => account.state === 'error'),
  );
}

function statusFromError(error: unknown): GhStatusResponse {
  const classified = classifyGhError(error);
  if (classified.code === 'GH_MISSING') {
    return { available: false, authenticated: false, reason: 'gh_missing' };
  }
  if (classified.code === 'AUTH_FAILED') {
    return { available: false, authenticated: false, reason: 'unauthenticated' };
  }
  return { available: false, authenticated: false, reason: 'unknown' };
}

export function deriveGhStatus(raw: GhAuthStatusJson | null, error?: unknown): GhStatusResponse {
  if (error) return statusFromError(error);
  if (!raw?.hosts || Object.keys(raw.hosts).length === 0) {
    return { available: false, authenticated: false, reason: 'unauthenticated' };
  }

  for (const [host, accounts] of Object.entries(raw.hosts)) {
    for (const account of accounts ?? []) {
      if (isAuthenticatedAccount(account)) {
        return {
          available: true,
          authenticated: true,
          reason: 'authenticated',
          host,
          login: account.login || undefined,
        };
      }
    }
  }

  return {
    available: false,
    authenticated: false,
    reason: hasAuthError(raw) ? 'auth_error' : 'unauthenticated',
  };
}
