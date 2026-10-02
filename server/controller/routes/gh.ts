import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { GH_DETAIL_TIMEOUT_MS, GIT_OPERATION_TIMEOUT_MS } from '../../../common/git-execution.js';
import { validateGhRequest } from '../../../common/git-request-validation.js';
import { GitServiceError } from '../../../common/git-error.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { executorIdFromValue } from './executor-target.js';
import { gitRouteFailure } from './git-executor-service.js';

export type GhServiceResolver = (executorId: string) => Promise<ExecutionGhService>;

const REQUEST_FIELDS = {
  getStatus: ['executorId'],
  listPullRequests: ['executorId', 'project'],
  getPullRequest: ['executorId', 'project', 'number'],
} satisfies Record<keyof ExecutionGhService, readonly string[]>;

export default function createGhRoutes(resolve: GhServiceResolver, timeoutMs = GH_DETAIL_TIMEOUT_MS): RouteMap {
  function route(method: keyof ExecutionGhService): RouteHandler {
    return async (request, url) => {
      try {
        const fields = REQUEST_FIELDS[method];
        for (const key of url.searchParams.keys()) {
          if (!fields.includes(key) || url.searchParams.getAll(key).length !== 1) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub request fields');
        }
        const executorId = executorIdFromValue(url.searchParams.get('executorId'));
        const projectPath = url.searchParams.get('project') ?? '';
        const number = Number(url.searchParams.get('number'));
        const input: { projectPath?: string; number?: number } = {};
        if (method !== 'getStatus') input.projectPath = projectPath;
        if (method === 'getPullRequest') input.number = number;
        validateGhRequest(method, input);
        const service = await resolve(executorId);
        const options = { signal: request.signal, timeoutMs: Math.min(timeoutMs, method === 'getPullRequest' ? GH_DETAIL_TIMEOUT_MS : GIT_OPERATION_TIMEOUT_MS) };
        let result;
        switch (method) {
          case 'getStatus':
            result = await service.getStatus(options);
            break;
          case 'listPullRequests':
            result = await service.listPullRequests({ projectPath }, options);
            break;
          case 'getPullRequest':
            result = await service.getPullRequest({ projectPath, number }, options);
            break;
        }
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
    '/api/v1/gh/pull-request': { GET: route('getPullRequest') },
  };
}
