// Agent CLI update routes report and start native CLI updates on one executor.

import type { AgentCliUpdateService } from '../cli-updates/cli-update-service.js';
import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { executorIdFromUrl, executorIdFromValue } from './executor-target.js';

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function createAgentCliUpdateRoutes(updates: Pick<AgentCliUpdateService, 'statuses' | 'start'>): RouteMap {
  async function getStatuses(request: Request, url: URL): Promise<Response> {
    try {
      const executorId = executorIdFromUrl(url);
      const refresh = url.searchParams.get('refresh') === '1';
      return noStore(Response.json(await updates.statuses(executorId, { refresh, signal: request.signal })));
    } catch (error) {
      if (request.signal.aborted) return noStore(new Response(null, { status: 499 }));
      return noStore(jsonErrorFromUnknown(error));
    }
  }

  async function postUpdate(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const executorId = executorIdFromValue(input.executorId);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      if (!agentId) return jsonError('agentId is required', 400);
      return noStore(Response.json(await updates.start(executorId, agentId)));
    } catch (error) {
      return noStore(jsonErrorFromUnknown(error));
    }
  }

  return {
    '/api/v1/agents/cli-updates': {
      GET: getStatuses,
      POST: withJsonBody(postUpdate),
    },
  };
}
