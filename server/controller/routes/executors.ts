import { parseCreateExecutorRequest, parseUpdateExecutorRequest } from '../../../common/executors.js';
import type { ExecutorManager } from '../executors/manager.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
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
      POST: withJsonBody((body, _request, _url, _server, context) => handle(async () => {
        const request = parseCreateExecutorRequest(body);
        if (!request) throw new ValidationDomainError('Invalid executor configuration');
        const created = await executors.create(request, context?.assertCurrent);
        return { id: created.id, ...executors.config.connection(created.id) };
      })),
    },
    '/api/v1/executors/:executorId': {
      PATCH: withJsonBody((body, _request, url, _server, context) => handle(async () => {
        const request = parseUpdateExecutorRequest(body);
        if (!request) throw new ValidationDomainError('Invalid executor update');
        const id = executorIdFromUrl(url);
        if (context?.principal?.mode === 'executor' && context.principal.executorId === id
          && Object.keys(request).some((key) => key !== 'label')) {
          throw new DomainError('CLI_ACCESS_DENIED', 'Only a label change is allowed through the managed executor itself; use another executor or the controller', 403);
        }
        await executors.update(id, request, context?.assertCurrent);
        return { executors: executors.list() };
      })),
      DELETE: (_request, url, _server, context) => handle(async () => {
        const id = executorIdFromUrl(url);
        if (context?.principal?.mode === 'executor' && context.principal.executorId === id) {
          throw new DomainError('CLI_ACCESS_DENIED', 'Delete this executor through another executor or the controller', 403);
        }
        await executors.remove(id, context?.assertCurrent);
        return { executors: executors.list() };
      }),
    },
    '/api/v1/executors/:executorId/connection': {
      GET: (_request, url) => handle(() => executors.config.connection(executorIdFromUrl(url))),
    },
  };
}

function executorIdFromUrl(url: URL): string { return url.pathname.split('/')[4] ?? ''; }
