import { isRecord } from '../../common/json.js';
import type { GitService } from '../git/git-service.js';
import {
  GIT_DIFF_LIMITS,
  GIT_REVIEW_DOCUMENT_LIMITS,
  type GitCommandTrace,
  type GitComparisonFreshnessToExpectation,
  type GitComparisonFromEndpoint,
  type GitComparisonMode,
  type GitComparisonRevisionExpectation,
  type GitComparisonToEndpoint,
  type GitReviewRouteMetrics,
} from '../git/types.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { jsonError } from '../lib/http-error.js';
import { withJsonBody } from '../lib/json-route.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { measureGitRoutePhase, traceGitJsonResponse } from './git-route-response.js';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function validContextLines(value: unknown): number | null {
  const context = typeof value === 'number' ? value : Number(value ?? 5);
  if (!Number.isInteger(context) || context < 0 || context > GIT_DIFF_LIMITS.maxContextLines) return null;
  return context;
}

function validPositiveLimit(value: unknown, fallback: number, max: number): number | null {
  const limit = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit <= 0 || limit > max) return null;
  return limit;
}

function validComparisonMode(value: unknown): GitComparisonMode | null {
  return value === 'direct' || value === 'merge-base' ? value : null;
}

function validComparisonFrom(value: unknown): GitComparisonFromEndpoint | null {
  if (!isRecord(value) || value.kind !== 'revision') return null;
  const revision = nonEmptyString(value.revision);
  return revision ? { kind: 'revision', revision } : null;
}

function validComparisonTo(value: unknown): GitComparisonToEndpoint | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'working-tree') return { kind: 'working-tree' };
  return validComparisonFrom(value);
}

function validResolvedHash(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value) ? value : null;
}

function validComparisonRevisionExpectation(
  value: unknown,
): GitComparisonRevisionExpectation | null {
  if (!isRecord(value) || value.kind !== 'revision') return null;
  const revision = nonEmptyString(value.revision);
  const hash = validResolvedHash(value.hash);
  return revision && hash ? { kind: 'revision', revision, hash } : null;
}

function validComparisonFreshnessTo(value: unknown): GitComparisonFreshnessToExpectation | null {
  const revision = validComparisonRevisionExpectation(value);
  if (revision) return revision;
  if (!isRecord(value) || value.kind !== 'working-tree') return null;
  const fingerprint = nonEmptyString(value.fingerprint);
  return fingerprint ? { kind: 'working-tree', fingerprint } : null;
}

function routeError(error: string): Response {
  return jsonError(error, 400);
}

async function gitJson(git: GitService, action: () => Promise<Response | unknown>): Promise<Response> {
  try {
    const result = await action();
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    return git.toHttpError(error);
  }
}

export function createGitComparisonRoutes(git: GitService): RouteMap {
  async function postSnapshot(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const from = validComparisonFrom(input.from);
      const to = validComparisonTo(input.to);
      const mode = validComparisonMode(input.mode);
      const context = validContextLines(input.context ?? 5);
      const bodyCandidateCount = validPositiveLimit(
        input.bodyCandidateCount,
        8,
        GIT_REVIEW_DOCUMENT_LIMITS.maxBodyBatchFiles,
      );
      if (!project || !from || !to || !mode) {
        return routeError('Missing or invalid comparison endpoints, project, or mode.');
      }
      if (to.kind === 'working-tree' && mode !== 'direct') {
        return routeError('Working Tree comparisons require direct mode.');
      }
      if (context === null || bodyCandidateCount === null) {
        return routeError('Invalid comparison snapshot parameters.');
      }

      const trace: GitCommandTrace[] = [];
      const metrics: GitReviewRouteMetrics = { phases: [] };
      const startedAt = performance.now();
      const result = await measureGitRoutePhase(metrics.phases, 'summary-git', () =>
        git.getComparisonSnapshot({
          projectPath: project,
          from,
          to,
          mode,
          context,
          bodyCandidateCount,
          trace,
          metrics,
          signal: request.signal,
        }));
      if (result.status === 'ready') {
        metrics.fileCount = result.files.length;
        metrics.rowCount = result.files.reduce((total, file) => total + file.estimatedRows, 0);
      }
      return traceGitJsonResponse('comparison-snapshot', startedAt, trace, result, metrics);
    });
  }

  async function postFreshness(body: JsonBody, request: Request): Promise<Response> {
    return gitJson(git, async () => {
      const input = asJsonBody(body);
      const project = nonEmptyString(input.project);
      const from = validComparisonRevisionExpectation(input.from);
      const to = validComparisonFreshnessTo(input.to);
      if (!project || !from || !to) {
        return routeError('Missing or invalid comparison freshness identities or project.');
      }

      const trace: GitCommandTrace[] = [];
      const startedAt = performance.now();
      const result = await git.getComparisonFreshness({
        projectPath: project,
        from,
        to,
        trace,
        signal: request.signal,
      });
      return traceGitJsonResponse('comparison-freshness', startedAt, trace, result);
    });
  }

  return {
    '/api/v1/git/comparisons/snapshot': { POST: withJsonBody(postSnapshot) },
    '/api/v1/git/comparisons/freshness': { POST: withJsonBody(postFreshness) },
  };
}
