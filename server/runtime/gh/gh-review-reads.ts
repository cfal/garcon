import type { GhRawNodes, GhRawPullRequestList, GhRawReviewTarget } from './gh-mappers.js';
import { buildPullRequestList, buildReviewTarget } from './gh-mappers.js';
import { GhDomainError } from './gh-types.js';
import { runGhJson } from './run.js';
import { LABELS_QUERY, LIST_QUERY, REQUESTED_QUERY, REVIEW_REQUESTS_QUERY, REVIEW_TARGET_QUERY } from './gh-review-queries.js';

const REPOSITORY_FIELDS = ['-F', 'owner={owner}', '-F', 'name={repo}'];

function graphql<T>(projectPath: string, query: string, fields: string[], cursor: string | null, signal?: AbortSignal): Promise<T> {
  return runGhJson<T>(projectPath, ['api', 'graphql', ...fields, '-f', `query=${query}`, ...(cursor ? ['-f', `endCursor=${cursor}`] : [])], { signal });
}

// A missing or unusable continuation fails the whole read instead of publishing a partial success.
async function completeConnection<T>(first: GhRawNodes<T> | null | undefined, next: (cursor: string) => Promise<GhRawNodes<T> | null | undefined>): Promise<GhRawNodes<T>> {
  const result: T[] = [];
  const seen = new Set<string>();
  let page = first;
  for (;;) {
    if (!page?.pageInfo || typeof page.pageInfo.hasNextPage !== 'boolean' || !Array.isArray(page.nodes)) throw new Error('GitHub returned an incomplete connection.');
    if ((page.issueCount ?? 0) > 1_000) throw new Error('GitHub review-request search exceeds its 1,000-result limit.');
    result.push(...page.nodes.filter((node): node is T => node !== null));
    if (!page.pageInfo.hasNextPage) return { nodes: result };
    const cursor = page.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error('GitHub returned an invalid pagination cursor.');
    seen.add(cursor);
    page = await next(cursor);
  }
}

export async function readPullRequestList(projectPath: string, signal?: AbortSignal) {
  const raw = await graphql<GhRawPullRequestList>(projectPath, LIST_QUERY, REPOSITORY_FIELDS, null, signal);
  const repository = raw.data?.repository;
  if (!repository) throw new Error('GitHub returned no repository for this project.');
  repository.pullRequests = await completeConnection(repository.pullRequests, async (cursor) =>
    (await graphql<GhRawPullRequestList>(projectPath, LIST_QUERY, REPOSITORY_FIELDS, cursor, signal)).data?.repository?.pullRequests);
  for (const pull of repository.pullRequests.nodes ?? []) {
    if (!pull) continue;
    const fields = [...REPOSITORY_FIELDS, '-F', `number=${pull.number}`];
    type NestedPage = { data?: { repository?: { pullRequest?: Pick<typeof pull, 'labels' | 'reviewRequests'> } } };
    pull.labels = await completeConnection(pull.labels, async (cursor) =>
      (await graphql<NestedPage>(projectPath, LABELS_QUERY, fields, cursor, signal)).data?.repository?.pullRequest?.labels);
    pull.reviewRequests = await completeConnection(pull.reviewRequests, async (cursor) =>
      (await graphql<NestedPage>(projectPath, REVIEW_REQUESTS_QUERY, fields, cursor, signal)).data?.repository?.pullRequest?.reviewRequests);
  }
  const requestedFields = ['-F', 'requested=repo:{owner}/{repo} is:pr is:open review-requested:@me'];
  const requested = await graphql<GhRawPullRequestList>(projectPath, REQUESTED_QUERY, requestedFields, null, signal);
  raw.data!.requested = await completeConnection(requested.data?.requested, async (cursor) =>
    (await graphql<GhRawPullRequestList>(projectPath, REQUESTED_QUERY, requestedFields, cursor, signal)).data?.requested);
  return buildPullRequestList(raw);
}

export async function readReviewTarget(projectPath: string, number: number, marker: string, signal?: AbortSignal) {
  const fields = [...REPOSITORY_FIELDS, '-F', `number=${number}`];
  const raw = await graphql<GhRawReviewTarget>(projectPath, REVIEW_TARGET_QUERY, fields, null, signal);
  const pull = raw.data?.repository?.pullRequest;
  if (!pull) throw new GhDomainError('NOT_FOUND', 'Pull request not found.');
  pull.comments = await completeConnection(pull.comments, async (cursor) => {
    const current = (await graphql<GhRawReviewTarget>(projectPath, REVIEW_TARGET_QUERY, fields, cursor, signal)).data?.repository?.pullRequest;
    if (!current) throw new GhDomainError('NOT_FOUND', 'Pull request not found.');
    pull.state = current.state;
    pull.headRefOid = current.headRefOid;
    return current.comments;
  });
  const target = buildReviewTarget(raw, marker);
  if (!target) throw new GhDomainError('NOT_FOUND', 'Pull request not found.');
  return target;
}
