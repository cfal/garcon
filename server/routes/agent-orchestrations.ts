// REST contract for Garcon-owned child-agent orchestration.

import { parseJsonBody } from '../lib/http-request.js';
import type { AgentOrchestrator } from '../agents/agent-orchestrator.js';
import type {
  AgentOrchestrationAbortRequest,
  AgentOrchestrationSpawnRequest,
  AgentOrchestrationWaitRequest,
} from '../../common/agent-orchestration.js';

type RouteHandler = (request: Request, url: URL) => Promise<Response> | Response;
type RouteMap = Record<string, Record<string, RouteHandler>>;

function jsonError(error: string, status: number): Response {
  return Response.json({ success: false, error }, { status });
}

export default function createAgentOrchestrationRoutes(orchestrator: AgentOrchestrator): RouteMap {
  async function postSpawn(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request) as Partial<AgentOrchestrationSpawnRequest>;
      const orchestration = await orchestrator.spawn({
        parentChatId: String(body.parentChatId ?? ''),
        tasks: Array.isArray(body.tasks) ? body.tasks : [],
        concurrencyLimit: body.concurrencyLimit,
      });
      return Response.json({ success: true, orchestration }, { status: 202 });
    } catch (error) {
      return jsonError((error as Error).message, 400);
    }
  }

  function getList(_request: Request, url: URL): Response {
    const orchestrationId = url.searchParams.get('orchestrationId');
    if (orchestrationId) {
      const orchestration = orchestrator.get(orchestrationId);
      if (!orchestration) return jsonError('Orchestration not found', 404);
      return Response.json({ success: true, orchestration });
    }
    const parentChatId = url.searchParams.get('parentChatId') ?? undefined;
    return Response.json({ success: true, orchestrations: orchestrator.list(parentChatId) });
  }

  async function postWait(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request) as Partial<AgentOrchestrationWaitRequest>;
      const result = await orchestrator.wait({
        orchestrationId: String(body.orchestrationId ?? ''),
        childIds: Array.isArray(body.childIds) ? body.childIds.filter((id): id is string => typeof id === 'string') : undefined,
        timeoutMs: body.timeoutMs,
      });
      return Response.json({ success: true, ...result });
    } catch (error) {
      return jsonError((error as Error).message, 400);
    }
  }

  async function postAbort(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request) as Partial<AgentOrchestrationAbortRequest>;
      const orchestration = await orchestrator.abort({
        orchestrationId: String(body.orchestrationId ?? ''),
        childIds: Array.isArray(body.childIds) ? body.childIds.filter((id): id is string => typeof id === 'string') : undefined,
      });
      return Response.json({ success: true, orchestration });
    } catch (error) {
      return jsonError((error as Error).message, 400);
    }
  }

  return {
    '/api/v1/agents/orchestrations': { GET: getList, POST: postSpawn },
    '/api/v1/agents/orchestrations/wait': { POST: postWait },
    '/api/v1/agents/orchestrations/abort': { POST: postAbort },
  };
}
