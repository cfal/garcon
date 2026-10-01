import { parseCreateExecutorRequest, parseUpdateExecutorRequest } from '../../../common/executors.js';
import type { ExecutorManager } from '../executors/manager.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { HttpRouteContext, RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { getPublicUrl } from '../config.js';
import { requestPublicUrl } from '../executors/public-url.js';

export function createExecutorRoutes(executors: ExecutorManager, publicUrl: string | null = getPublicUrl()): RouteMap {
  const resolvePublicBase = (request: Request, context?: HttpRouteContext): string => {
    if (context?.principal?.mode === 'executor' && publicUrl === null) {
      throw new ValidationDomainError('Executor CLI requests have no public Host; configure GARCON_PUBLIC_URL / --public-url on the controller or set an explicit executor advertised URL');
    }
    return requestPublicUrl(request, publicUrl);
  };
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
      POST: withJsonBody((body, incoming, _url, _server, context) => handle(async () => {
        const request = parseCreateExecutorRequest(body);
        if (!request) throw new ValidationDomainError('Invalid executor configuration');
        const publicBase = request.direction === 'executor-connects' && request.advertisedUrl === undefined
          ? resolvePublicBase(incoming, context) : undefined;
        const created = await executors.create(request, { publicBase, assertCurrent: context?.assertCurrent });
        return { id: created.id, ...executors.config.connection(created.id, publicBase) };
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
      GET: (request, url, _server, context) => handle(() => {
        const id = executorIdFromUrl(url);
        const config = executors.config.require(id);
        const base = config.connection.kind === 'executor-connects' && config.connection.advertisedUrl === null
          ? resolvePublicBase(request, context) : undefined;
        return executors.config.connection(id, base);
      }),
    },
  };
}

function executorIdFromUrl(url: URL): string { return url.pathname.split('/')[4] ?? ''; }
