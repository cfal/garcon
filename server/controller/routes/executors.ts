import { parseCreateExecutorRequest, parseUpdateExecutorRequest } from '../../../common/executors.js';
import type { ExecutorManager } from '../executors/manager.js';
import { ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';

export function createExecutorRoutes(executors: ExecutorManager): RouteMap {
  const noStore = (response: Response) => {
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  const handle = async (operation: () => unknown | Promise<unknown>) => {
    try { return noStore(Response.json(await operation())); }
    catch (error) { return noStore(jsonErrorFromUnknown(error)); }
  };
  return {
    '/api/v1/executors': {
      GET: () => handle(() => ({ executors: executors.list() })),
      POST: withJsonBody((body) => handle(async () => {
        const request = parseCreateExecutorRequest(body);
        if (!request) throw new ValidationDomainError('Invalid executor configuration');
        const created = await executors.create(request);
        return { id: created.id, ...executors.config.connection(created.id) };
      })),
    },
    '/api/v1/executors/:executorId': {
      PATCH: withJsonBody((body, _request, url) => handle(async () => {
        const request = parseUpdateExecutorRequest(body);
        if (!request) throw new ValidationDomainError('Invalid executor update');
        await executors.update(executorIdFromUrl(url), request);
        return { executors: executors.list() };
      })),
      DELETE: (_request, url) => handle(async () => {
        await executors.remove(executorIdFromUrl(url));
        return { executors: executors.list() };
      }),
    },
    '/api/v1/executors/:executorId/connection': {
      GET: (_request, url) => handle(() => executors.config.connection(executorIdFromUrl(url))),
    },
  };
}

function executorIdFromUrl(url: URL): string { return url.pathname.split('/')[4] ?? ''; }
