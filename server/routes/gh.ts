import { createGhService } from '../gh/gh-service.js';
import type { GhService } from '../gh/gh-service.js';
import type { RouteMap } from '../lib/http-route-types.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  projectBoundaryErrorResponse,
} from '../lib/path-boundary.ts';

// GitHub pull request routes. Read-only viewer surface backed by the `gh` CLI.
export default function createGhRoutes(gh: GhService = createGhService()): RouteMap {
  async function getGhStatus(request: Request): Promise<Response> {
    try {
      const status = await gh.getStatus(request.signal);
      return Response.json(status);
    } catch (error) {
      return gh.toHttpError(error);
    }
  }

  async function getPullRequests(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }
    try {
      const projectPath = await assertRealWithinProjectBase(project);
      const result = await gh.listPullRequests({ projectPath, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      if (isProjectBoundaryError(error)) return projectBoundaryErrorResponse();
      return gh.toHttpError(error);
    }
  }

  async function getPullRequest(request: Request, url: URL): Promise<Response> {
    const project = url.searchParams.get('project');
    if (!project) {
      return Response.json({ error: 'Missing required parameter: project.' }, { status: 400 });
    }
    const numberParam = url.searchParams.get('number');
    const number = numberParam ? Number(numberParam) : Number.NaN;
    if (!Number.isInteger(number) || number <= 0) {
      return Response.json({ error: 'Missing or invalid parameter: number.' }, { status: 400 });
    }
    try {
      const projectPath = await assertRealWithinProjectBase(project);
      const result = await gh.getPullRequest({ projectPath, number, signal: request.signal });
      return Response.json(result);
    } catch (error) {
      if (isProjectBoundaryError(error)) return projectBoundaryErrorResponse();
      return gh.toHttpError(error);
    }
  }

  return {
    '/api/v1/gh/status': { GET: getGhStatus },
    '/api/v1/gh/pull-requests': { GET: getPullRequests },
    '/api/v1/gh/pull-request': { GET: getPullRequest },
  };
}
