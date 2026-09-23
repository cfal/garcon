import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { GH_DETAIL_TIMEOUT_MS, GIT_OPERATION_TIMEOUT_MS } from '../../common/git-execution.js';
import { validateGhRequest } from '../../common/git-request-validation.js';
import { GitServiceError } from '../../common/git-error.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { executionNodeIdFromValue } from './node-target.js';
import { gitRouteFailure } from './git-node-service.js';

export type GhServiceResolver = (nodeId: string) => Promise<ExecutionGhService>;

export default function createGhRoutes(resolve: GhServiceResolver, timeoutMs = GH_DETAIL_TIMEOUT_MS): RouteMap {
  function route(method: keyof ExecutionGhService): RouteHandler {
    return async (request, url) => {
      try {
        const fields = method === 'getStatus' ? ['nodeId'] : method === 'listPullRequests' ? ['nodeId', 'project'] : ['nodeId', 'project', 'number'];
        for (const key of url.searchParams.keys()) {
          if (!fields.includes(key) || url.searchParams.getAll(key).length !== 1) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub request fields');
        }
        const nodeId = executionNodeIdFromValue(url.searchParams.get('nodeId'));
        const projectPath = url.searchParams.get('project') ?? '';
        const number = Number(url.searchParams.get('number'));
        const input = method === 'getStatus' ? {} : method === 'listPullRequests' ? { projectPath } : { projectPath, number };
        validateGhRequest(method, input);
        const service = await resolve(nodeId);
        const options = { signal: request.signal, timeoutMs: Math.min(timeoutMs, method === 'getPullRequest' ? GH_DETAIL_TIMEOUT_MS : GIT_OPERATION_TIMEOUT_MS) };
        const result = method === 'getStatus' ? await service.getStatus(options)
          : method === 'listPullRequests' ? await service.listPullRequests({ projectPath }, options)
            : await service.getPullRequest({ projectPath, number }, options);
        if (result.nodeId !== nodeId || typeof result.instanceId !== 'string' || !result.instanceId) {
          throw new GitServiceError('GIT_INVALID_RESULT', 'Invalid GitHub response scope');
        }
        return Response.json(result);
      } catch (error) { return gitRouteFailure(error); }
    };
  }
  return {
    '/api/v1/gh/status': { GET: route('getStatus') },
    '/api/v1/gh/pull-requests': { GET: route('listPullRequests') },
    '/api/v1/gh/pull-request': { GET: route('getPullRequest') },
  };
}
