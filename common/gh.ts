import type { GitReviewFilePatchBody, GitReviewFileSummary } from './git.js';

export type GhAvailabilityReason =
  | 'authenticated'
  | 'unauthenticated'
  | 'gh_missing'
  | 'auth_error'
  | 'unknown';

export interface GhStatusResponse {
  available: boolean;
  authenticated: boolean;
  reason: GhAvailabilityReason;
  login?: string;
  host?: string;
}

export type PullRequestState = 'open' | 'closed' | 'merged';
export type PullRequestChecksState = 'passing' | 'failing' | 'pending' | 'none';
export type PullRequestReviewDecision =
  | 'approved'
  | 'changes_requested'
  | 'review_required'
  | null;
export type PullRequestMergeable = 'mergeable' | 'conflicting' | 'unknown';
export type PullRequestThreadSide = 'before' | 'after';
export type PullRequestCheckState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'neutral'
  | 'skipped';

export interface PullRequestSummary {
  number: number;
  title: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  url: string;
  reviewDecision: PullRequestReviewDecision;
  checksState: PullRequestChecksState;
}

export interface PullRequestListResult {
  pulls: PullRequestSummary[];
  repo: { nameWithOwner: string } | null;
}

export interface PullRequestReviewCommentItem {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface PullRequestThread {
  id: string;
  path: string;
  side: PullRequestThreadSide;
  line: number;
  diffHunk: string;
  isOutdated: boolean;
  comments: PullRequestReviewCommentItem[];
}

export interface PullRequestCheck {
  name: string;
  state: PullRequestCheckState;
  url?: string;
}

export interface PullRequestDetail {
  number: number;
  title: string;
  body: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  createdAt: string;
  updatedAt: string;
  url: string;
  mergeable: PullRequestMergeable;
  reviewDecision: PullRequestReviewDecision;
  checks: PullRequestCheck[];
  files: GitReviewFileSummary[];
  fileBodies: Record<string, GitReviewFilePatchBody>;
  threads: PullRequestThread[];
}
