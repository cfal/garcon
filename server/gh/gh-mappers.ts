// Pure transforms from raw `gh` JSON output into the typed PR contract. Kept
// free of subprocess IO so they can be unit-tested directly.

import type { GitDiffPatchFile } from '../git/diff-engine.js';
import type { GitReviewFilePatchBody, GitReviewFileSummary } from '../git/types.js';
import type {
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestChecksState,
  PullRequestDetail,
  PullRequestMergeable,
  PullRequestReviewDecision,
  PullRequestState,
  PullRequestSummary,
  PullRequestThread,
} from './gh-types.js';

export interface GhRawAuthor {
  login?: string;
  name?: string;
}

export interface GhRawStatusCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface GhRawFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface GhRawPullRequest {
  number: number;
  title?: string;
  body?: string;
  state?: string;
  isDraft?: boolean;
  author?: GhRawAuthor | null;
  headRefName?: string;
  baseRefName?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  createdAt?: string;
  updatedAt?: string;
  url?: string;
  mergeable?: string;
  reviewDecision?: string;
  statusCheckRollup?: GhRawStatusCheck[] | null;
  files?: GhRawFile[];
}

export interface GhRawReviewComment {
  id: number;
  path?: string;
  body?: string;
  user?: { login?: string } | null;
  created_at?: string;
  in_reply_to_id?: number;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  diff_hunk?: string;
}

function authorLogin(author: GhRawAuthor | null | undefined): string {
  return author?.login || author?.name || 'unknown';
}

export function mapPrState(raw: string | undefined): PullRequestState {
  const value = (raw ?? '').toUpperCase();
  if (value === 'MERGED') return 'merged';
  if (value === 'CLOSED') return 'closed';
  return 'open';
}

export function mapMergeable(raw: string | undefined): PullRequestMergeable {
  const value = (raw ?? '').toUpperCase();
  if (value === 'MERGEABLE') return 'mergeable';
  if (value === 'CONFLICTING') return 'conflicting';
  return 'unknown';
}

export function mapReviewDecision(raw: string | undefined): PullRequestReviewDecision {
  const value = (raw ?? '').toUpperCase();
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  if (value === 'REVIEW_REQUIRED') return 'review_required';
  return null;
}

function mapCheckState(check: GhRawStatusCheck): PullRequestCheckState {
  const status = (check.status ?? '').toUpperCase();
  const conclusion = (check.conclusion ?? check.state ?? '').toUpperCase();
  if (status && status !== 'COMPLETED') return 'pending';
  if (['SUCCESS', 'NEUTRAL'].includes(conclusion)) {
    return conclusion === 'NEUTRAL' ? 'neutral' : 'success';
  }
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(conclusion)) {
    return 'failure';
  }
  if (['SKIPPED', 'STALE'].includes(conclusion)) return 'skipped';
  if (['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'REQUESTED', 'WAITING'].includes(conclusion)) {
    return 'pending';
  }
  return conclusion === '' ? 'pending' : 'neutral';
}

export function mapChecks(rollup: GhRawStatusCheck[] | null | undefined): PullRequestCheck[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((check) => ({
    name: check.name || check.context || 'check',
    state: mapCheckState(check),
    ...(check.detailsUrl || check.targetUrl
      ? { url: check.detailsUrl || check.targetUrl }
      : {}),
  }));
}

export function mapChecksState(
  rollup: GhRawStatusCheck[] | null | undefined,
): PullRequestChecksState {
  const checks = mapChecks(rollup);
  if (checks.length === 0) return 'none';
  if (checks.some((check) => check.state === 'failure')) return 'failing';
  if (checks.some((check) => check.state === 'pending')) return 'pending';
  return 'passing';
}

export function mapSummary(raw: GhRawPullRequest): PullRequestSummary {
  return {
    number: raw.number,
    title: raw.title ?? '',
    state: raw.isDraft ? 'open' : mapPrState(raw.state),
    isDraft: Boolean(raw.isDraft),
    author: authorLogin(raw.author),
    headRefName: raw.headRefName ?? '',
    baseRefName: raw.baseRefName ?? '',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    updatedAt: raw.updatedAt ?? '',
    url: raw.url ?? '',
    reviewDecision: mapReviewDecision(raw.reviewDecision),
    checksState: mapChecksState(raw.statusCheckRollup),
  };
}

// Groups flat review comments into threads keyed by their root comment id.
export function buildThreads(comments: GhRawReviewComment[]): PullRequestThread[] {
  const groups = new Map<number, GhRawReviewComment[]>();
  for (const comment of comments) {
    const rootId = comment.in_reply_to_id ?? comment.id;
    const group = groups.get(rootId);
    if (group) group.push(comment);
    else groups.set(rootId, [comment]);
  }

  const threads: PullRequestThread[] = [];
  for (const [rootId, group] of groups) {
    const sorted = [...group].sort((a, b) =>
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    );
    const root = sorted.find((comment) => comment.id === rootId) ?? sorted[0];
    threads.push({
      id: String(rootId),
      path: root.path ?? '',
      side: (root.side ?? '').toUpperCase() === 'LEFT' ? 'before' : 'after',
      line: root.line ?? root.original_line ?? 0,
      diffHunk: root.diff_hunk ?? '',
      isOutdated: root.line == null,
      comments: sorted.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? 'unknown',
        body: comment.body ?? '',
        createdAt: comment.created_at ?? '',
      })),
    });
  }

  return threads.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line,
  );
}

export interface PullRequestPatchFileSet {
  files: GitReviewFileSummary[];
  fileBodies: Record<string, GitReviewFilePatchBody>;
}

// Builds review file summaries and bodies from compact PR patches, preferring
// GitHub's per-file line counts (authoritative, includes binary files).
export function buildPatchFileSet(
  patches: GitDiffPatchFile[],
  ghFiles: GhRawFile[] | undefined,
): PullRequestPatchFileSet {
  const ghFileMap = new Map((ghFiles ?? []).map((file) => [file.path, file]));
  const files = patches.map((file): GitReviewFileSummary => {
    const gh = ghFileMap.get(file.path);
    return {
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      indexStatus: ' ',
      workTreeStatus: file.status,
      category: file.body.category,
      additions: gh?.additions ?? file.additions,
      deletions: gh?.deletions ?? file.deletions,
      estimatedRows: file.body.renderedRowCount,
      bodyState: file.body.bodyState,
      bodyFingerprint: file.body.bodyFingerprint,
      isGenerated: file.body.category === 'generated',
      isBinary: file.body.isBinary,
      isTooLarge: file.body.isTooLarge,
      ...(file.body.limitReason ? { limitReason: file.body.limitReason } : {}),
      ...(file.body.limitMessage ? { limitMessage: file.body.limitMessage } : {}),
    };
  });
  const fileBodies: Record<string, GitReviewFilePatchBody> = {};
  for (const file of patches) fileBodies[file.path] = file.body;
  return { files, fileBodies };
}

export function buildDetail(
  raw: GhRawPullRequest,
  patches: GitDiffPatchFile[],
  threads: PullRequestThread[],
): PullRequestDetail {
  const { files, fileBodies } = buildPatchFileSet(patches, raw.files);
  return {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    state: raw.isDraft ? 'open' : mapPrState(raw.state),
    isDraft: Boolean(raw.isDraft),
    author: authorLogin(raw.author),
    headRefName: raw.headRefName ?? '',
    baseRefName: raw.baseRefName ?? '',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? files.length,
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    url: raw.url ?? '',
    mergeable: mapMergeable(raw.mergeable),
    reviewDecision: mapReviewDecision(raw.reviewDecision),
    checks: mapChecks(raw.statusCheckRollup),
    files,
    fileBodies,
    threads,
  };
}
