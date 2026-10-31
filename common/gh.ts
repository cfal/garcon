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
  getPullRequestFingerprints: PullRequestFingerprintBatch;
  getPullRequestStatus: PullRequestStatus;
  getPullRequestDiff: PullRequestDiff;
  getPullRequestReviewThreads: PullRequestReviewThreads;
  getPullRequestReviewTarget: PullRequestReviewTarget;
  createPullRequestComment: PullRequestCommentRef;
  minimizePullRequestComment: PullRequestCommentMinimized;
}

export interface GhRequests {
  getStatus: Record<string, never>;
  listPullRequests: { projectPath: string; repository?: GhRepositoryIdentity };
  // Distinct repositories on one GitHub host, at most `GH_FINGERPRINT_BATCH_SIZE`.
  getPullRequestFingerprints: { repositories: GhRepositoryIdentity[] };
  getPullRequestStatus: { projectPath: string; repository: GhRepositoryIdentity; number: number };
  // The diff is read only while the pull request is still at `commits`.
  getPullRequestDiff: { projectPath: string; repository: GhRepositoryIdentity; number: number; commits: PullRequestCommits };
  getPullRequestReviewThreads: { projectPath: string; repository: GhRepositoryIdentity; number: number };
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

// Each GraphQL fingerprint query aliases at most this many repositories.
export const GH_FINGERPRINT_BATCH_SIZE = 25;

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
  mergeable: PullRequestMergeable;
  headRefOid: string;
  baseRefOid: string;
  reviewCount: number;
  reviewThreadCount: number;
  // True when the head branch lives in another repository, such as a fork.
  isCrossRepository: boolean;
  authorAssociation: PullRequestAuthorAssociation;
  authorIsBot: boolean;
  authoredByViewer: boolean;
  labels: string[];
  reviewRequest: PullRequestReviewRequest;
}

// The summary fields that decide which reads of a pull request are stale.
export const PULL_REQUEST_FINGERPRINT_FIELDS = [
  'number', 'updatedAt', 'isDraft', 'headRefOid', 'baseRefOid', 'checksState',
  'reviewDecision', 'mergeable', 'reviewCount', 'reviewThreadCount',
] as const satisfies readonly (keyof PullRequestSummary)[];

export type PullRequestFingerprint = Pick<PullRequestSummary, typeof PULL_REQUEST_FINGERPRINT_FIELDS[number]>;

// One repository of a fingerprint batch. A repository GitHub would not read, or
// one with more open pull requests than a single page, carries no fingerprints,
// so a caller cannot mistake it for an unchanged one.
export type RepositoryPullRequestFingerprints =
  | { kind: 'read'; repo: { nameWithOwner: string; url: string }; pulls: PullRequestFingerprint[] }
  | { kind: 'incomplete' }
  | { kind: 'failed'; reason: 'not-found' | 'forbidden' | 'error'; message: string };

export interface PullRequestFingerprintBatch {
  viewerLogin: string;
  // In request order.
  repositories: RepositoryPullRequestFingerprints[];
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

// The commit pair a pull request diff is computed from. GitHub diffs the head
// against its merge base with the base, so the pair identifies the diff exactly.
export interface PullRequestCommits {
  baseRefOid: string;
  headRefOid: string;
}

// Metadata that changes without a push: checks, review decision, mergeability,
// and the commit pair that tells a reader whether its diff is still current.
export interface PullRequestStatus extends PullRequestCommits {
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
}

export interface PullRequestDiff extends PullRequestCommits {
  number: number;
  files: GitReviewFileSummary[];
  fileBodies: Record<string, GitReviewFilePatchBody>;
}

export interface PullRequestReviewThreads extends PullRequestCommits {
  number: number;
  threads: PullRequestThread[];
}
