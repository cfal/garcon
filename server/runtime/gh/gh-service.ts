import { createLogger } from '../../common/log.js';
import { GH_COMMENT_ID_MAX_LENGTH, type GhRequests, type GhRepositoryIdentity, type GhStatusResponse } from '../../../common/gh.js';
import { ghRepositoryIdentity, sameGhRepository } from '../../../common/gh-identity.js';
import { GitServiceError } from '../../../common/git-error.js';
import { classifyGhError } from './gh-error-classifier.js';
import { assertAccessibleDirectory, parseGhJson, runGhJson, runGhMutation } from './run.js';
import { deriveGhStatus, type GhAuthStatusJson } from './gh-status.js';
import {
  GhDomainError,
  type PullRequestCommentMinimized,
  type PullRequestFingerprintBatch,
  type PullRequestCommentRef,
  type PullRequestDiff,
  type PullRequestListResult,
  type PullRequestReviewTarget,
  type PullRequestReviewThreads,
  type PullRequestStatus,
} from './gh-types.js';
import { readPullRequestList, readReviewTarget } from './gh-review-reads.js';
import { readPullRequestDiff, readPullRequestReviewThreads, readPullRequestStatus } from './gh-pull-request-reads.js';
import { readPullRequestFingerprints } from './gh-fingerprint-reads.js';
import { GhResponseCache } from './gh-response-cache.js';
import { PullRequestDiffCache } from './pull-request-diff-cache.js';
import { assertGhActor, readPostingActor, requireGhActor, resolveCheckoutRepository } from './gh-repository.js';

const logger = createLogger('gh:service');

const MINIMIZE_MUTATION = `mutation($id:ID!){
  minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}
}`;
const COMMENT_IDENTITY_QUERY = `query($id:ID!){
  viewer{id login}
  node(id:$id){... on IssueComment{author{login ... on Node{id}} repository{nameWithOwner url}}}
}`;
const STATUS_TIMEOUT_MS = 10_000;

type WithSignal<T> = T & { signal?: AbortSignal };
export type ListPullRequestsOptions = WithSignal<GhRequests['listPullRequests']>;
export type GetPullRequestFingerprintsOptions = WithSignal<GhRequests['getPullRequestFingerprints']>;
export type GetPullRequestStatusOptions = WithSignal<GhRequests['getPullRequestStatus']>;
export type GetPullRequestDiffOptions = WithSignal<GhRequests['getPullRequestDiff']>;
export type GetPullRequestReviewThreadsOptions = WithSignal<GhRequests['getPullRequestReviewThreads']>;
export type GetPullRequestReviewTargetOptions = WithSignal<GhRequests['getPullRequestReviewTarget']>;
export type CreatePullRequestCommentOptions = WithSignal<GhRequests['createPullRequestComment']>;
export type MinimizePullRequestCommentOptions = WithSignal<GhRequests['minimizePullRequestComment']>;

export interface GhOperations {
  getStatus(signal?: AbortSignal): Promise<GhStatusResponse>;
  listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestListResult>;
  getPullRequestFingerprints(options: GetPullRequestFingerprintsOptions): Promise<PullRequestFingerprintBatch>;
  getPullRequestStatus(options: GetPullRequestStatusOptions): Promise<PullRequestStatus>;
  getPullRequestDiff(options: GetPullRequestDiffOptions): Promise<PullRequestDiff>;
  getPullRequestReviewThreads(options: GetPullRequestReviewThreadsOptions): Promise<PullRequestReviewThreads>;
  getPullRequestReviewTarget(options: GetPullRequestReviewTargetOptions): Promise<PullRequestReviewTarget>;
  createPullRequestComment(options: CreatePullRequestCommentOptions): Promise<PullRequestCommentRef>;
  minimizePullRequestComment(options: MinimizePullRequestCommentOptions): Promise<PullRequestCommentMinimized>;
}

function assertPullRequestNumber(number: number): void {
  if (!Number.isInteger(number) || number <= 0) {
    throw new GhDomainError('INVALID_INPUT', 'Pull request number must be a positive integer.');
  }
}

// Every pull request read binds the live checkout to the repository it names.
async function assertPullRequestTarget(projectPath: string, repository: GhRepositoryIdentity, number: number, signal?: AbortSignal): Promise<void> {
  assertPullRequestNumber(number);
  await assertAccessibleDirectory(projectPath);
  await resolveCheckoutRepository(projectPath, repository, signal);
}

// Read state an executor's serving instance owns and clears when it is disposed.
export class GhReadCaches {
  readonly diffs = new PullRequestDiffCache();
  readonly responses = new GhResponseCache();

  clear(): void {
    this.diffs.clear();
    this.responses.clear();
  }
}

// Each caller resolves its own authorization; mutable reads never share credentials or results.
export function createGhOperations(statusDirectory = process.cwd(), caches = new GhReadCaches()): GhOperations {
  return {
    async getStatus(signal): Promise<GhStatusResponse> {
      try {
        const raw = await runGhJson<GhAuthStatusJson>(
          statusDirectory,
          ['auth', 'status', '--json', 'hosts'],
          { signal, timeoutMs: STATUS_TIMEOUT_MS },
        );
        return deriveGhStatus(raw);
      } catch (error) {
        signal?.throwIfAborted();
        const status = deriveGhStatus(null, error);
        if (status.reason === 'unknown') logger.warn('[gh] failed to resolve gh auth status', { code: classifyGhError(error).code });
        return status;
      }
    },

    async listPullRequests({ projectPath, repository, signal }): Promise<PullRequestListResult> {
      await assertAccessibleDirectory(projectPath);
      const identity = await resolveCheckoutRepository(projectPath, repository, signal);
      return readPullRequestList(projectPath, identity, signal);
    },

    async getPullRequestFingerprints({ repositories, signal }): Promise<PullRequestFingerprintBatch> {
      return readPullRequestFingerprints(statusDirectory, repositories, signal);
    },

    async getPullRequestStatus({ projectPath, repository, number, signal }): Promise<PullRequestStatus> {
      await assertPullRequestTarget(projectPath, repository, number, signal);
      return readPullRequestStatus(projectPath, repository, number, signal);
    },

    async getPullRequestDiff({ projectPath, repository, number, commits, signal }): Promise<PullRequestDiff> {
      await assertPullRequestTarget(projectPath, repository, number, signal);
      return readPullRequestDiff(projectPath, repository, number, commits, caches.diffs, signal);
    },

    async getPullRequestReviewThreads({ projectPath, repository, number, signal }): Promise<PullRequestReviewThreads> {
      await assertPullRequestTarget(projectPath, repository, number, signal);
      return readPullRequestReviewThreads(projectPath, repository, number, caches.responses, signal);
    },

    async getPullRequestReviewTarget({ projectPath, repository, number, marker, signal }): Promise<PullRequestReviewTarget> {
      await assertPullRequestTarget(projectPath, repository, number, signal);
      return readReviewTarget(projectPath, repository, number, marker, signal);
    },

    async createPullRequestComment({ projectPath, repository, actor, number, body, expected, signal }): Promise<PullRequestCommentRef> {
      try {
        assertPullRequestNumber(number);
        await assertAccessibleDirectory(projectPath);
        await resolveCheckoutRepository(projectPath, repository, signal);
        assertGhActor(await readPostingActor(projectPath, repository, signal), actor);
        const current = await runGhJson<{ state: string; headRefOid: string }>(projectPath,
          ['pr', 'view', String(number), '--repo', `${repository.host}/${repository.nameWithOwner}`, '--json', 'state,headRefOid'], { signal });
        if (current.state !== expected.state.toUpperCase() || current.headRefOid !== expected.headRefOid) {
          throw new GitServiceError('GH_STALE_PULL_REQUEST', 'The pull request is no longer open at the reviewed commit, so this review was not posted.');
        }
        // The body arrives on stdin because a full-length comment exceeds the size of one argument.
        const { stdout } = await runGhMutation(
          projectPath,
          ['api', '--hostname', repository.host, '--method', 'POST', `repos/${repository.nameWithOwner}/issues/${number}/comments`, '-F', 'body=@-'],
          { signal, stdin: body },
        );
        try {
          const created = parseGhJson<{ node_id?: string; html_url?: string; user?: { node_id?: string; login?: string } } | null>(stdout, 'api');
          if (typeof created?.node_id !== 'string' || !created.node_id
            || created.node_id.length > GH_COMMENT_ID_MAX_LENGTH || created.node_id.includes('\0')) throw new Error('Invalid comment identity');
          if (created.html_url !== undefined && typeof created.html_url !== 'string') throw new Error('Invalid comment URL');
          // External auth can still change after the preflight; never confirm a different author.
          if (created.user?.node_id !== actor.id) throw new Error('Comment author changed');
          return { id: created.node_id, url: created.html_url ?? '' };
        } catch {
          // An unusable successful reply cannot prove whether GitHub created the comment.
          throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'GitHub did not return a usable comment identity. Check for the comment before trying again.');
        }
      } catch (error) {
        if (error instanceof GitServiceError && (error.code === 'GIT_MUTATION_OUTCOME_UNKNOWN' || error.code === 'GH_STALE_PULL_REQUEST')) throw error;
        throw new GitServiceError('GH_MUTATION_REJECTED', error instanceof Error ? error.message : 'The comment was not created.');
      }
    },

    async minimizePullRequestComment({ projectPath, repository, actor, commentId, signal }): Promise<PullRequestCommentMinimized> {
      await assertAccessibleDirectory(projectPath);
      await resolveCheckoutRepository(projectPath, repository, signal);
      const identity = await runGhJson<{ data?: { viewer?: unknown; node?: { author?: unknown; repository?: { nameWithOwner: string; url: string } } } }>(
        projectPath, ['api', 'graphql', '--hostname', repository.host, '-f', `id=${commentId}`, '-f', `query=${COMMENT_IDENTITY_QUERY}`], { signal });
      assertGhActor(requireGhActor(identity.data?.viewer), actor);
      assertGhActor(requireGhActor(identity.data?.node?.author), actor);
      const commentRepository = identity.data?.node?.repository && ghRepositoryIdentity(identity.data.node.repository);
      if (!commentRepository || !sameGhRepository(commentRepository, repository)) throw new GitServiceError('GIT_CONFLICT', 'The comment belongs to another GitHub repository.');
      const { stdout } = await runGhMutation(
        projectPath,
        ['api', 'graphql', '--hostname', repository.host, '-f', `id=${commentId}`, '-f', `query=${MINIMIZE_MUTATION}`],
        { signal },
      );
      const raw = parseGhJson<{ data?: { minimizeComment?: { minimizedComment?: { isMinimized?: boolean } | null } | null } | null }>(stdout, 'api');
      return { minimized: raw.data?.minimizeComment?.minimizedComment?.isMinimized === true };
    },

  };
}
