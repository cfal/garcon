import type { InspectManagedWorktreeRequest, ManagedWorktreeSnapshot } from './git-managed-worktrees.js';

export function isCredentialFreeGitRemoteUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\r\n]/.test(value)) return false;
  if (/^[a-z0-9][a-z0-9+.-]*::/i.test(value)) return false;
  // WHATWG normalization can hide userinfo that Git's HTTP transport still sends.
  if (/^https?:/i.test(value) && value.includes('\\')) return false;
  if (!value.includes('://')) return true;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol) && !url.password
      && (!(url.protocol === 'http:' || url.protocol === 'https:') || !url.username);
  } catch { return false; }
}

export interface InspectCommitRequest {
  readonly projectPath: string;
  readonly commit: string;
  readonly ancestor: string | null;
}

export interface CommitIdentity {
  readonly commit: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly containsAncestor: boolean | null;
}

export interface ExactRemoteRefRequest {
  readonly projectPath: string;
  readonly remote: string;
  readonly expectedRemoteUrl: string;
  readonly ref: string;
  readonly commit: string;
}

export interface PushExactRefRequest extends ExactRemoteRefRequest {
  readonly expectedRemoteCommit: string | null;
}

export interface ExactRefResult {
  readonly success: true;
  readonly ref: string;
  readonly commit: string;
}
export interface IntegrateCommitsRequest extends InspectManagedWorktreeRequest {
  readonly expectedRepositoryIdentity: string;
  readonly expectedWorktreeIdentity: string;
  readonly expectedHead: string;
  readonly expectedBranch: string;
  readonly commits: readonly string[];
  readonly strategy: 'ordered-merge';
}

export type IntegrateCommitsResult =
  | { readonly kind: 'integrated'; readonly managed: ManagedWorktreeSnapshot }
  | { readonly kind: 'conflicts'; readonly managed: ManagedWorktreeSnapshot; readonly paths: readonly string[] }
  | { readonly kind: 'unknown'; readonly reason: string };
