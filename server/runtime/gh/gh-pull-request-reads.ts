// Independent pull request reads. Status is cheap and changes with every CI
// tick; the diff is expensive and changes only with its commit pair; review
// threads change with review activity. Each read is its own `gh` round trip so
// a caller refreshes only the part that changed.

import type { GhRepositoryIdentity, PullRequestCommits, PullRequestDiff, PullRequestReviewThreads, PullRequestStatus } from '../../../common/gh.js';
import { GitServiceError } from '../../../common/git-error.js';
import { buildDiff, buildStatus, buildThreads, type GhRawPullRequest, type GhRawReviewComment } from './gh-mappers.js';
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
  const view = () => runGhJson<PullRequestCommits>(
    projectPath,
    ['pr', 'view', String(number), '--repo', explicitRepository(repository), '--json', 'baseRefOid,headRefOid'],
    { signal },
  );
  // Every caller proves access before waiting for or reusing another caller's diff.
  assertCommits(await view(), commits);
  return cache.load(key, async () => {
    const comparison = `repos/${repository.nameWithOwner}/compare/${commits.baseRefOid}...${commits.headRefOid}`;
    const diff = await runGh(projectPath, ['api', '--hostname', repository.host, comparison, '-H', 'Accept: application/vnd.github.diff'], { signal, timeoutMs: DIFF_TIMEOUT_MS });
    assertCommits(await view(), commits);
    // Patch headers and counts come from the same immutable comparison as the bodies.
    return buildDiff(number, commits, parseMultiFileDiffPatches(diff.stdout), undefined);
  }, signal);
}

export async function readPullRequestReviewThreads(projectPath: string, repository: GhRepositoryIdentity, number: number, signal?: AbortSignal): Promise<PullRequestReviewThreads> {
  const view = () => runGhJson<PullRequestCommits>(projectPath,
    ['pr', 'view', String(number), '--repo', explicitRepository(repository), '--json', 'baseRefOid,headRefOid'], { signal });
  const commits = await view();
  const pages = await runGhJson<GhRawReviewComment[][]>(
    projectPath,
    ['api', '--hostname', repository.host, '--paginate', '--slurp', `repos/${repository.nameWithOwner}/pulls/${number}/comments`],
    { signal },
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new GitServiceError('GIT_INVALID_RESULT', 'GitHub returned unreadable review comments.');
  assertCommits(await view(), commits);
  return { number, ...commits, threads: buildThreads(pages.flat()) };
}
