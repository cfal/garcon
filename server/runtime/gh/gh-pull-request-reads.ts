// Independent pull request reads. Status is cheap and changes with every CI
// tick; the diff is expensive and changes only with its commit pair; review
// threads change with review activity. Each read is its own `gh` round trip so
// a caller refreshes only the part that changed.

import type { GhRepositoryIdentity, PullRequestCommits, PullRequestDiff, PullRequestReviewThreads, PullRequestStatus } from '../../../common/gh.js';
import { GitServiceError } from '../../../common/git-error.js';
import { buildDiff, buildStatus, buildThreads, type GhRawFile, type GhRawPullRequest, type GhRawReviewComment } from './gh-mappers.js';
import { parseMultiFileDiffPatches } from './pull-request-diff.js';
import type { PullRequestDiffCache } from './pull-request-diff-cache.js';
import { runGh, runGhJson } from './run.js';

const STATUS_FIELDS =
  'number,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,baseRefOid,additions,deletions,changedFiles,createdAt,updatedAt,url,mergeable,reviewDecision,statusCheckRollup';
const DIFF_TIMEOUT_MS = 60_000;

function explicitRepository(repository: GhRepositoryIdentity): string {
  return `${repository.host}/${repository.nameWithOwner}`;
}

function assertCommits(actual: Partial<PullRequestCommits>, expected: PullRequestCommits): void {
  if (actual.baseRefOid !== expected.baseRefOid || actual.headRefOid !== expected.headRefOid) {
    throw new GitServiceError('GH_STALE_PULL_REQUEST', 'The pull request moved to other commits. Refresh to load its current changes.');
  }
}

export async function readPullRequestStatus(projectPath: string, repository: GhRepositoryIdentity, number: number, signal?: AbortSignal): Promise<PullRequestStatus> {
  const raw = await runGhJson<GhRawPullRequest>(
    projectPath,
    ['pr', 'view', String(number), '--repo', explicitRepository(repository), '--json', STATUS_FIELDS],
    { signal },
  );
  return buildStatus(raw);
}

// Returns the diff of `commits` only while the pull request is still at them.
export async function readPullRequestDiff(
  projectPath: string,
  repository: GhRepositoryIdentity,
  number: number,
  commits: PullRequestCommits,
  cache: PullRequestDiffCache,
  signal?: AbortSignal,
): Promise<PullRequestDiff> {
  const key = { repository, number, commits };
  const view = (fields: string) => runGhJson<Partial<PullRequestCommits> & { files?: GhRawFile[] }>(
    projectPath,
    ['pr', 'view', String(number), '--repo', explicitRepository(repository), '--json', fields],
    { signal },
  );
  const cached = cache.get(key);
  if (cached) {
    // The light read proves the executor's current account can still see the pull request.
    assertCommits(await view('baseRefOid,headRefOid'), commits);
    return cached;
  }
  const diff = await runGh(projectPath, ['pr', 'diff', String(number), '--repo', explicitRepository(repository)], { signal, timeoutMs: DIFF_TIMEOUT_MS });
  // `gh pr diff` cannot name a commit, so the pair is confirmed after the diff
  // arrives; a push during the read fails as stale instead of caching the new
  // diff under the old pair.
  const current = await view('baseRefOid,headRefOid,files');
  assertCommits(current, commits);
  const result = buildDiff(number, commits, parseMultiFileDiffPatches(diff.stdout), current.files);
  cache.set(key, result);
  return result;
}

export async function readPullRequestReviewThreads(projectPath: string, repository: GhRepositoryIdentity, number: number, signal?: AbortSignal): Promise<PullRequestReviewThreads> {
  const pages = await runGhJson<GhRawReviewComment[][]>(
    projectPath,
    ['api', '--hostname', repository.host, '--paginate', '--slurp', `repos/${repository.nameWithOwner}/pulls/${number}/comments`],
    { signal },
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned unreadable review comments.');
  return { number, threads: buildThreads(pages.flat()) };
}
