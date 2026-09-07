import { parseMultiFileDiffPatches } from '../git/diff-engine.js';
import { createLogger } from '../lib/log.js';
import type { GhStatusResponse } from '../../common/gh.js';
import { classifyGhError, type ClassifiedGhError } from './gh-error-classifier.js';
import { assertAccessibleDirectory, runGh, runGhJson } from './run.js';
import { deriveGhStatus, type GhAuthStatusJson } from './gh-status.js';
import {
  buildDetail,
  buildThreads,
  mapSummary,
  type GhRawPullRequest,
  type GhRawReviewComment,
} from './gh-mappers.js';
import {
  GhDomainError,
  type PullRequestDetail,
  type PullRequestListResult,
} from './gh-types.js';

const logger = createLogger('gh:service');

const LIST_FIELDS =
  'number,title,state,isDraft,author,headRefName,baseRefName,additions,deletions,changedFiles,updatedAt,url,reviewDecision,statusCheckRollup';
const VIEW_FIELDS =
  'number,title,body,state,isDraft,author,headRefName,baseRefName,additions,deletions,changedFiles,createdAt,updatedAt,url,mergeable,reviewDecision,statusCheckRollup,files';
const STATUS_TIMEOUT_MS = 10_000;
const DIFF_TIMEOUT_MS = 60_000;

export interface ListPullRequestsOptions {
  projectPath: string;
  signal?: AbortSignal;
}

export interface GetPullRequestOptions extends ListPullRequestsOptions {
  number: number;
}

export interface GhService {
  getStatus(signal?: AbortSignal): Promise<GhStatusResponse>;
  listPullRequests(options: ListPullRequestsOptions): Promise<PullRequestListResult>;
  getPullRequest(options: GetPullRequestOptions): Promise<PullRequestDetail>;
  toHttpError(error: unknown): Response;
}

function ghDomainErrorToResponse(error: GhDomainError): Response {
  const status =
    error.code === 'INVALID_INPUT'
      ? 400
      : error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'AUTH_FAILED'
          ? 401
          : 500;
  return Response.json({ error: error.message, errorCode: error.code }, { status });
}

function classifiedGhErrorToResponse(classified: ClassifiedGhError): Response {
  const body: { error: string; errorCode: string; details?: string } = {
    error: classified.message,
    errorCode: classified.code,
  };
  if (classified.details) body.details = classified.details;
  return Response.json(body, { status: classified.status });
}

async function loadReviewThreads(
  projectPath: string,
  number: number,
  signal?: AbortSignal,
): Promise<ReturnType<typeof buildThreads>> {
  try {
    const comments = await runGhJson<GhRawReviewComment[]>(
      projectPath,
      ['api', '--paginate', `repos/{owner}/{repo}/pulls/${number}/comments`],
      { signal },
    );
    return buildThreads(Array.isArray(comments) ? comments : []);
  } catch (error) {
    // Review threads are best-effort; a comment fetch failure should not blank
    // out the whole PR view.
    logger.warn('[gh] failed to load review threads', error);
    return [];
  }
}

export function createGhService(): GhService {
  return {
    async getStatus(signal): Promise<GhStatusResponse> {
      try {
        const raw = await runGhJson<GhAuthStatusJson>(
          process.cwd(),
          ['auth', 'status', '--json', 'hosts'],
          { signal, timeoutMs: STATUS_TIMEOUT_MS },
        );
        return deriveGhStatus(raw);
      } catch (error) {
        const status = deriveGhStatus(null, error);
        if (status.reason === 'unknown') logger.warn('[gh] failed to resolve gh auth status', error);
        return status;
      }
    },

    async listPullRequests({ projectPath, signal }): Promise<PullRequestListResult> {
      await assertAccessibleDirectory(projectPath);
      const raw = await runGhJson<GhRawPullRequest[]>(
        projectPath,
        ['pr', 'list', '--state', 'open', '--limit', '100', '--json', LIST_FIELDS],
        { signal },
      );
      const pulls = (Array.isArray(raw) ? raw : []).map(mapSummary);

      let repo: PullRequestListResult['repo'] = null;
      try {
        const repoRaw = await runGhJson<{ nameWithOwner?: string }>(
          projectPath,
          ['repo', 'view', '--json', 'nameWithOwner'],
          { signal },
        );
        if (repoRaw.nameWithOwner) repo = { nameWithOwner: repoRaw.nameWithOwner };
      } catch (error) {
        logger.warn('[gh] failed to resolve repo name', error);
      }

      return { pulls, repo };
    },

    async getPullRequest({ projectPath, number, signal }): Promise<PullRequestDetail> {
      if (!Number.isInteger(number) || number <= 0) {
        throw new GhDomainError('INVALID_INPUT', 'Pull request number must be a positive integer.');
      }
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

    toHttpError(error: unknown): Response {
      logger.error('[gh]', error);
      if (error instanceof GhDomainError) {
        return ghDomainErrorToResponse(error);
      }
      return classifiedGhErrorToResponse(classifyGhError(error));
    },
  };
}
