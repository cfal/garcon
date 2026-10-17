import type { GhRawNodes, GhRawPullRequestList, GhRawReviewTarget } from './gh-mappers.js';
import { buildPullRequestList, buildReviewTarget } from './gh-mappers.js';
import { GhDomainError } from './gh-types.js';
import { runGhJson } from './run.js';
import { LABELS_QUERY, LIST_QUERY, REQUESTED_QUERY, REVIEW_REQUESTS_QUERY, REVIEW_TARGET_QUERY } from './gh-review-queries.js';
import type { GhActorIdentity, GhRepositoryIdentity } from '../../../common/gh.js';
import { ghRepositoryIdentity, sameGhRepository } from '../../../common/gh-identity.js';
import { GitServiceError } from '../../../common/git-error.js';
import { assertGhActor, repositoryFields, requireGhActor } from './gh-repository.js';

type ReadEnvelope = { data?: { viewer?: GhActorIdentity | null; repository?: { nameWithOwner?: string; url?: string } | null } | null };

async function graphql<T>(projectPath: string, repository: GhRepositoryIdentity, query: string, fields: string[], cursor: string | null, signal?: AbortSignal, viewer?: GhActorIdentity): Promise<T> {
  const raw = await runGhJson<T>(projectPath, ['api', 'graphql', '--hostname', repository.host, ...fields, '-f', `query=${query}`, ...(cursor ? ['-f', `endCursor=${cursor}`] : [])], { signal });
  const data = (raw as ReadEnvelope).data;
  const actor = requireGhActor(data?.viewer);
  if (viewer) assertGhActor(actor, viewer);
  if (data?.repository) {
    const actual = ghRepositoryIdentity({ nameWithOwner: data.repository.nameWithOwner ?? '', url: data.repository.url ?? '' });
    if (!actual || !sameGhRepository(actual, repository)) throw new GitServiceError('GIT_CONFLICT', 'The GitHub repository identity changed during the read.');
  }
  return raw;
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

export async function readPullRequestList(projectPath: string, identity: GhRepositoryIdentity, signal?: AbortSignal) {
  const fields = repositoryFields(identity);
  const raw = await graphql<GhRawPullRequestList>(projectPath, identity, LIST_QUERY, fields, null, signal);
  const viewer = requireGhActor(raw.data?.viewer);
  const repository = raw.data?.repository;
  if (!repository) throw new Error('GitHub returned no repository for this project.');
  repository.pullRequests = await completeConnection(repository.pullRequests, async (cursor) =>
    (await graphql<GhRawPullRequestList>(projectPath, identity, LIST_QUERY, fields, cursor, signal, viewer)).data?.repository?.pullRequests);
  for (const pull of repository.pullRequests.nodes ?? []) {
    if (!pull) continue;
    const fields = [...repositoryFields(identity), '-F', `number=${pull.number}`];
    type NestedPage = ReadEnvelope & { data?: { repository?: { pullRequest?: Pick<typeof pull, 'labels' | 'reviewRequests'> } } };
    pull.labels = await completeConnection(pull.labels, async (cursor) =>
      (await graphql<NestedPage>(projectPath, identity, LABELS_QUERY, fields, cursor, signal, viewer)).data?.repository?.pullRequest?.labels);
    pull.reviewRequests = await completeConnection(pull.reviewRequests, async (cursor) =>
      (await graphql<NestedPage>(projectPath, identity, REVIEW_REQUESTS_QUERY, fields, cursor, signal, viewer)).data?.repository?.pullRequest?.reviewRequests);
  }
  const requestedFields = ['-f', `requested=repo:${identity.nameWithOwner} is:pr is:open review-requested:@me`];
  const requested = await graphql<GhRawPullRequestList>(projectPath, identity, REQUESTED_QUERY, requestedFields, null, signal, viewer);
  raw.data!.requested = await completeConnection(requested.data?.requested, async (cursor) =>
    (await graphql<GhRawPullRequestList>(projectPath, identity, REQUESTED_QUERY, requestedFields, cursor, signal, viewer)).data?.requested);
  return buildPullRequestList(raw);
}

export async function readReviewTarget(projectPath: string, identity: GhRepositoryIdentity, number: number, marker: string, signal?: AbortSignal) {
  const fields = [...repositoryFields(identity), '-F', `number=${number}`];
  const raw = await graphql<GhRawReviewTarget>(projectPath, identity, REVIEW_TARGET_QUERY, fields, null, signal);
  const viewer = requireGhActor(raw.data?.viewer);
  const pull = raw.data?.repository?.pullRequest;
  if (!pull) throw new GhDomainError('NOT_FOUND', 'Pull request not found.');
  pull.comments = await completeConnection(pull.comments, async (cursor) => {
    const current = (await graphql<GhRawReviewTarget>(projectPath, identity, REVIEW_TARGET_QUERY, fields, cursor, signal, viewer)).data?.repository?.pullRequest;
    if (!current) throw new GhDomainError('NOT_FOUND', 'Pull request not found.');
    pull.state = current.state;
    pull.headRefOid = current.headRefOid;
    return current.comments;
  });
  const target = buildReviewTarget(raw, marker);
  if (!target) throw new GhDomainError('NOT_FOUND', 'Pull request not found.');
  return target;
}
