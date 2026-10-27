import { isUsageWindowRetained, parseUsageReadRequest } from '../../../common/usage.js';
import { ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { UsageService } from '../usage/usage-service.js';
import { executorIdFromUrl } from './executor-target.js';

const WINDOW_PARAMS = ['sinceDay', 'untilDay', 'timeZone'] as const;

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function createUsageRoutes(
  usage: Pick<UsageService, 'readSummary'>,
  readTimeoutMs: number,
  now: () => number = Date.now,
): RouteMap {
  return {
    '/api/v1/usage': {
      GET: async (request, url) => {
        try {
          const executorId = executorIdFromUrl(url);
          if (WINDOW_PARAMS.some((key) => url.searchParams.getAll(key).length !== 1)) {
            throw new ValidationDomainError('Invalid usage window');
          }
          const window = parseUsageReadRequest(Object.fromEntries(WINDOW_PARAMS.map((key) => [key, url.searchParams.get(key)])));
          if (!window || !isUsageWindowRetained(window, now())) throw new ValidationDomainError('Invalid usage window');
          const summary = await usage.readSummary(executorId, window, { signal: request.signal, timeoutMs: readTimeoutMs });
          return noStore(Response.json(summary));
        } catch (error) {
          if (request.signal.aborted) return noStore(new Response(null, { status: 499 }));
          return noStore(jsonErrorFromUnknown(error));
        }
      },
    },
  };
}
