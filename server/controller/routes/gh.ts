import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { GH_DETAIL_TIMEOUT_MS, ghOperationTimeoutMs } from '../../../common/git-execution.js';
import { validateGhRequest } from '../../../common/git-request-validation.js';
import { GitServiceError } from '../../../common/git-error.js';
import type { GhRequests } from '../../../common/gh.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { executorIdFromValue } from './executor-target.js';
import { gitRouteFailure } from './git-executor-service.js';

// The browser reads GitHub through these methods; review posting stays inside the controller.
type BrowserGhMethod = 'getStatus' | 'listPullRequests' | 'getPullRequestStatus' | 'getPullRequestDiff' | 'getPullRequestReviewThreads';

export type GhServiceResolver = (executorId: string) => Promise<Pick<ExecutionGhService, BrowserGhMethod>>;

const PULL_REQUEST_FIELDS = ['executorId', 'project', 'number', 'repositoryHost', 'repositoryName'] as const;

const REQUEST_FIELDS = {
  getStatus: ['executorId'],
  listPullRequests: ['executorId', 'project'],
  getPullRequestStatus: PULL_REQUEST_FIELDS,
  getPullRequestDiff: [...PULL_REQUEST_FIELDS, 'baseRefOid', 'headRefOid'],
  getPullRequestReviewThreads: PULL_REQUEST_FIELDS,
} satisfies Record<BrowserGhMethod, readonly string[]>;

type PullRequestRead = GhRequests['getPullRequestStatus'];

function pullRequestRead(url: URL): PullRequestRead {
  return {
    projectPath: url.searchParams.get('project') ?? '',
    number: Number(url.searchParams.get('number')),
    repository: {
      host: url.searchParams.get('repositoryHost') ?? '',
      nameWithOwner: url.searchParams.get('repositoryName') ?? '',
    },
  };
}

export default function createGhRoutes(resolve: GhServiceResolver, timeoutMs = GH_DETAIL_TIMEOUT_MS): RouteMap {
  function route(method: BrowserGhMethod): RouteHandler {
    return async (request, url) => {
      try {
        const fields: readonly string[] = REQUEST_FIELDS[method];
        for (const key of url.searchParams.keys()) {
          if (!fields.includes(key) || url.searchParams.getAll(key).length !== 1) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub request fields');
        }
        const executorId = executorIdFromValue(url.searchParams.get('executorId'));
        const options = { signal: request.signal, timeoutMs: Math.min(timeoutMs, ghOperationTimeoutMs(method)) };
        let call: (service: Pick<ExecutionGhService, BrowserGhMethod>) => Promise<{ executorId: string; instanceId: string }>;
        switch (method) {
          case 'getStatus': {
            validateGhRequest(method, {});
            call = service => service.getStatus(options);
            break;
          }
          case 'listPullRequests': {
            const input = { projectPath: url.searchParams.get('project') ?? '' };
            validateGhRequest(method, input);
            call = service => service.listPullRequests(input, options);
            break;
          }
          case 'getPullRequestStatus':
          case 'getPullRequestReviewThreads': {
            const input = pullRequestRead(url);
            validateGhRequest(method, input);
            call = method === 'getPullRequestStatus'
              ? service => service.getPullRequestStatus(input, options)
              : service => service.getPullRequestReviewThreads(input, options);
            break;
          }
          case 'getPullRequestDiff': {
            const input = {
              ...pullRequestRead(url),
              commits: { baseRefOid: url.searchParams.get('baseRefOid') ?? '', headRefOid: url.searchParams.get('headRefOid') ?? '' },
            };
            validateGhRequest(method, input);
            call = service => service.getPullRequestDiff(input, options);
            break;
          }
        }
        const result = await call(await resolve(executorId));
        if (result.executorId !== executorId || typeof result.instanceId !== 'string' || !result.instanceId) {
          throw new GitServiceError('GIT_INVALID_RESULT', 'Invalid GitHub response scope');
        }
        return Response.json(result);
      } catch (error) {
        return gitRouteFailure(error);
      }
    };
  }
  return {
    '/api/v1/gh/status': { GET: route('getStatus') },
    '/api/v1/gh/pull-requests': { GET: route('listPullRequests') },
    '/api/v1/gh/pull-request/status': { GET: route('getPullRequestStatus') },
    '/api/v1/gh/pull-request/diff': { GET: route('getPullRequestDiff') },
    '/api/v1/gh/pull-request/review-threads': { GET: route('getPullRequestReviewThreads') },
  };
}
