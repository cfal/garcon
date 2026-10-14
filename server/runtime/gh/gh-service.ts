import { parseMultiFileDiffPatches } from './pull-request-diff.js';
import { createLogger } from '../../common/log.js';
import type { GhStatusResponse } from '../../../common/gh.js';
import { classifyGhError } from './gh-error-classifier.js';
import { assertAccessibleDirectory, parseGhJson, runGh, runGhJson, runGhMutation } from './run.js';
import { deriveGhStatus, type GhAuthStatusJson } from './gh-status.js';
import {
  buildDetail,
  buildThreads,
  type GhRawPullRequest,
  type GhRawReviewComment,
} from './gh-mappers.js';
import {
  GhDomainError,
  type PullRequestCommentMinimized,
  type PullRequestCommentRef,
  type PullRequestDetail,
  type PullRequestListResult,
  type PullRequestReviewTarget,
} from './gh-types.js';

const logger = createLogger('gh:service');

const VIEW_FIELDS =
  'number,title,body,state,isDraft,author,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,createdAt,updatedAt,url,mergeable,reviewDecision,statusCheckRollup,files';
import { readPullRequestList, readReviewTarget } from './gh-review-reads.js';

const MINIMIZE_MUTATION = `mutation($id:ID!){
  minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}
}`;
const STATUS_TIMEOUT_MS = 10_000;
const DIFF_TIMEOUT_MS = 60_000;

export interface ListPullRequestsOptions {
  projectPath: string;
  signal?: AbortSignal;
}

export interface GetPullRequestOptions extends ListPullRequestsOptions {
  number: number;
}

export interface GetPullRequestReviewTargetOptions extends GetPullRequestOptions {
  marker: string;
}

export interface CreatePullRequestCommentOptions extends GetPullRequestOptions {
  body: string;
}

export interface MinimizePullRequestCommentOptions extends ListPullRequestsOptions {
  commentId: string;
}

export interface GhOperations {
  getStatus(signal?: AbortSignal): Promise<GhStatusResponse>;
  listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestListResult>;
  getPullRequest(options: GetPullRequestOptions): Promise<PullRequestDetail>;
  getPullRequestReviewTarget(options: GetPullRequestReviewTargetOptions): Promise<PullRequestReviewTarget>;
  createPullRequestComment(options: CreatePullRequestCommentOptions): Promise<PullRequestCommentRef>;
  minimizePullRequestComment(options: MinimizePullRequestCommentOptions): Promise<PullRequestCommentMinimized>;
}

function assertPullRequestNumber(number: number): void {
  if (!Number.isInteger(number) || number <= 0) {
    throw new GhDomainError('INVALID_INPUT', 'Pull request number must be a positive integer.');
  }
}

async function loadReviewThreads(
  projectPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReturnType<typeof buildThreads>> {
  try {
    const pages = await runGhJson<GhRawReviewComment[][]>(
      projectPath,
      ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${number}/comments`],
      { signal },
    );
    return buildThreads(Array.isArray(pages) ? pages.flat() : []);
  } catch (error) {
    signal?.throwIfAborted();
    // Review threads are best-effort; a comment fetch failure should not blank
    // out the whole PR view.
    logger.warn('[gh] failed to load review threads', { code: classifyGhError(error).code });
    return [];
  }
}

export function createGhOperations(statusDirectory = process.cwd()): GhOperations {
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

    async listPullRequests({ projectPath, signal }): Promise<PullRequestListResult> {
      await assertAccessibleDirectory(projectPath);
      return readPullRequestList(projectPath, signal);
    },

    async getPullRequest({ projectPath, number, signal }): Promise<PullRequestDetail> {
      assertPullRequestNumber(number);
      await assertAccessibleDirectory(projectPath);

      const [raw, diff, threads] = await Promise.all([
        runGhJson<GhRawPullRequest>(
          projectPath,
          ['pr', 'view', String(number), '--json', VIEW_FIELDS],
          { signal },
        ),
        runGh(
          projectPath,
          ['pr', 'diff', String(number)],
          { signal, timeoutMs: DIFF_TIMEOUT_MS },
        ),
        loadReviewThreads(projectPath, number, signal),
      ]);
      const diffText = diff.stdout;
      const patches = parseMultiFileDiffPatches(diffText);
      return buildDetail(raw, patches, threads);
    },

    async getPullRequestReviewTarget({ projectPath, number, marker, signal }): Promise<PullRequestReviewTarget> {
      assertPullRequestNumber(number);
      await assertAccessibleDirectory(projectPath);
      return readReviewTarget(projectPath, number, marker, signal);
    },

    async createPullRequestComment({ projectPath, number, body, signal }): Promise<PullRequestCommentRef> {
      assertPullRequestNumber(number);
      await assertAccessibleDirectory(projectPath);
      // The body arrives on stdin because a full-length comment exceeds the size of one argument.
      const { stdout } = await runGhMutation(
        projectPath,
        ['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${number}/comments`, '-F', 'body=@-'],
        { signal, stdin: body },
      );
      const created = parseGhJson<{ node_id?: string; html_url?: string }>(stdout, 'api');
      if (!created.node_id) throw new Error('gh api returned no comment identity.');
      return { id: created.node_id, url: created.html_url ?? '' };
    },

    async minimizePullRequestComment({ projectPath, commentId, signal }): Promise<PullRequestCommentMinimized> {
      await assertAccessibleDirectory(projectPath);
      const { stdout } = await runGhMutation(
        projectPath,
        ['api', 'graphql', '-f', `id=${commentId}`, '-f', `query=${MINIMIZE_MUTATION}`],
        { signal },
      );
      const raw = parseGhJson<{ data?: { minimizeComment?: { minimizedComment?: { isMinimized?: boolean } | null } | null } | null }>(stdout, 'api');
      return { minimized: raw.data?.minimizeComment?.minimizedComment?.isMinimized === true };
    },

  };
}
