import { parseCreateExecutionNodeRequest, parseUpdateExecutionNodeRequest } from '../../common/execution-nodes.js';
import type { ExecutionNodeManager } from '../execution-nodes/manager.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

export function createExecutionNodeRoutes(nodes: ExecutionNodeManager): RouteMap {
  const noStore = (response: Response) => {
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  const handle = async (operation: () => unknown | Promise<unknown>) => {
    try { return noStore(Response.json(await operation())); }
    catch (error) { return noStore(jsonErrorFromUnknown(error)); }
  };
  return {
    '/api/v1/execution-nodes': {
      GET: () => handle(() => ({ nodes: nodes.list() })),
      POST: withJsonBody((body) => handle(async () => {
        const request = parseCreateExecutionNodeRequest(body);
        if (!request) throw new ValidationDomainError('Invalid execution-node configuration');
        const created = await nodes.create(request);
        return { id: created.id, ...nodes.config.connection(created.id) };
      })),
    },
    '/api/v1/execution-nodes/:nodeId': {
      PATCH: withJsonBody((body, _request, url) => handle(async () => {
        const request = parseUpdateExecutionNodeRequest(body);
        if (!request) throw new ValidationDomainError('Invalid execution-node update');
        await nodes.update(nodeIdFromUrl(url), request);
        return { nodes: nodes.list() };
      })),
      DELETE: (_request, url) => handle(async () => {
        await nodes.remove(nodeIdFromUrl(url));
        return { nodes: nodes.list() };
      }),
    },
    '/api/v1/execution-nodes/:nodeId/connection': {
      GET: (_request, url) => handle(() => nodes.config.connection(nodeIdFromUrl(url))),
    },
  };
}

function nodeIdFromUrl(url: URL): string { return url.pathname.split('/')[4] ?? ''; }
