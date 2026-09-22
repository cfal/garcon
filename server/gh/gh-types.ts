// Shared types and domain error for GitHub CLI (`gh`) operations. The pull
// request detail reuses the git review file shapes so the frontend can render
// PR diffs with the exact same components as the local workbench.

import type { GitReviewFilePatchBody, GitReviewFileSummary } from '../git/types.js';

// Domain error type for gh operations. Carries a machine-readable code for
// HTTP status mapping at the route boundary.
export class GhDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GhDomainError';
    this.code = code;
  }
}

export type * from '../../common/gh.js';

export interface GhCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GhCommandResult {
  stdout: string;
  stderr: string;
}

export interface GhProcessError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
}
