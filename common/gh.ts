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

export interface GhResults {
  getStatus: GhStatusResponse;
  listPullRequests: PullRequestListResult;
  getPullRequest: PullRequestDetail;
  getPullRequestReviewTarget: PullRequestReviewTarget;
  createPullRequestComment: PullRequestCommentRef;
  minimizePullRequestComment: PullRequestCommentMinimized;
}

export interface GhRequests {
  getStatus: Record<string, never>;
  listPullRequests: { projectPath: string; repository?: GhRepositoryIdentity };
  getPullRequest: { projectPath: string; repository: GhRepositoryIdentity; number: number };
  getPullRequestReviewTarget: { projectPath: string; repository: GhRepositoryIdentity; number: number; marker: string };
  createPullRequestComment: { projectPath: string; repository: GhRepositoryIdentity; actor: GhActorIdentity; number: number; body: string; expected: { state: 'open'; headRefOid: string } };
  minimizePullRequestComment: { projectPath: string; repository: GhRepositoryIdentity; actor: GhActorIdentity; commentId: string };
}

export interface GhRepositoryIdentity {
  host: string;
  nameWithOwner: string;
}

export interface GhActorIdentity {
  id: string;
  login: string;
}

export const GH_MUTATIONS = [
  'createPullRequestComment', 'minimizePullRequestComment',
] as const satisfies readonly (keyof GhRequests)[];

export function isGhMutation(method: keyof GhRequests): boolean {
  return (GH_MUTATIONS as readonly string[]).includes(method);
}

// GitHub rejects issue comments longer than this many characters.
export const GH_COMMENT_BODY_MAX_LENGTH = 65_536;
export const GH_COMMENT_MARKER_MAX_LENGTH = 256;
export const GH_COMMENT_ID_MAX_LENGTH = 256;

export type PullRequestState = 'open' | 'closed' | 'merged';
export type PullRequestChecksState = 'passing' | 'failing' | 'pending' | 'none';
export type PullRequestReviewDecision =
  | 'approved'
  | 'changes_requested'
  | 'review_required'
  | null;
export const PULL_REQUEST_AUTHOR_ASSOCIATIONS = [
  'owner', 'member', 'collaborator', 'contributor', 'first_time_contributor', 'first_timer', 'mannequin', 'none',
] as const;
export type PullRequestAuthorAssociation = typeof PULL_REQUEST_AUTHOR_ASSOCIATIONS[number];
// Whether the viewer was asked to review directly or through one of their teams.
export type PullRequestReviewRequest = 'me' | 'team' | null;
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
  createdAt: string;
  updatedAt: string;
  url: string;
  reviewDecision: PullRequestReviewDecision;
  checksState: PullRequestChecksState;
  headRefOid: string;
  // True when the head branch lives in another repository, such as a fork.
  isCrossRepository: boolean;
  authorAssociation: PullRequestAuthorAssociation;
  authorIsBot: boolean;
  authoredByViewer: boolean;
  labels: string[];
  reviewRequest: PullRequestReviewRequest;
}

export interface PullRequestListResult {
  pulls: PullRequestSummary[];
  repo: { nameWithOwner: string; url: string } | null;
  // The `gh` login the executor reads and posts as.
  viewerLogin: string | null;
}

export interface PullRequestCommentRef {
  id: string;
  url: string;
}

// A comment carrying a hidden marker that starts with the requested prefix.
export interface PullRequestMarkedComment extends PullRequestCommentRef {
  marker: string;
  isMinimized: boolean;
  author: GhActorIdentity | null;
}

export interface PullRequestReviewTarget {
  repository: GhRepositoryIdentity;
  viewer: GhActorIdentity;
  number: number;
  state: PullRequestState;
  headRefOid: string;
  markedComments: PullRequestMarkedComment[];
}

export interface PullRequestCommentMinimized {
  minimized: boolean;
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
  headRefOid: string;
  mergeable: PullRequestMergeable;
  reviewDecision: PullRequestReviewDecision;
  checks: PullRequestCheck[];
  files: GitReviewFileSummary[];
  fileBodies: Record<string, GitReviewFilePatchBody>;
  threads: PullRequestThread[];
}
