// Agent routes expose runtime catalog, auth, and readiness state.

import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ApiProviderService } from '../api-providers/service.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { executorIdFromUrl, executorIdFromValue } from './executor-target.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';

interface AgentRouteDeps {
  agents: AgentRegistryServiceContract;
  apiProviders: ApiProviderService;
}

export default function createAgentRoutes({ agents, apiProviders }: AgentRouteDeps): RouteMap {
  function validateAuthLoginAgent(agentId: string, executorId: string): Response | null {
    if (!agents.hasAgent(agentId, executorId)) {
      return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
    }
    if (!agents.supportsAuthLogin(agentId, executorId)) {
      return Response.json({ error: `Auth login is not supported for agent: ${agentId}` }, { status: 400 });
    }
    return null;
  }

  function validateAuthLoginCompletionAgent(agentId: string, executorId: string): Response | null {
    if (!agents.hasAgent(agentId, executorId)) {
      return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
    }
    if (!agents.supportsAuthLoginCompletion(agentId, executorId)) {
      return Response.json(
        { error: `Auth login completion is not supported for agent: ${agentId}` },
        { status: 400 },
      );
    }
    return null;
  }

  async function getAgents(_request: Request, url: URL): Promise<Response> {
    try {
      return Response.json({
        agents: await agents.getAgentCatalogEntries(executorIdFromUrl(url)),
        apiProviders: apiProviders.getCatalog(executorIdFromUrl(url)),
      });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAgentAuth(_request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    try {
      const executorId = executorIdFromUrl(url);
      if (agentId) {
        const status = await agents.getAgentAuthStatus(agentId, executorId);
        if (!status) {
          return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
        }
        return Response.json({ [agentId]: status });
      }
      return Response.json(await agents.getAgentAuthStatusMap(executorId));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAgentReadiness(_request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await agents.getAgentReadinessMap(undefined, executorIdFromUrl(url)));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postAgentAuthLogin(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const executorId = executorIdFromValue(input.executorId);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      if (!agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      const invalidAgent = validateAuthLoginAgent(agentId, executorId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.launchAgentAuthLogin(agentId, executorId));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAgentAuthLoginStatus(_request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    const expectedSessionId = url.searchParams.get('session') ?? undefined;
    if (!agentId) {
      return Response.json({ error: 'agent is required' }, { status: 400 });
    }
    try {
      const executorId = executorIdFromUrl(url);
      const invalidAgent = validateAuthLoginAgent(agentId, executorId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.getAgentAuthLoginStatus(agentId, expectedSessionId, executorId));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postAgentAuthComplete(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const executorId = executorIdFromValue(input.executorId);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
      const code = typeof input.code === 'string' ? input.code : '';
      if (!agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      if (!code.trim()) {
        return Response.json({ error: 'code is required' }, { status: 400 });
      }
      if (!sessionId) {
        return Response.json({ error: 'sessionId is required' }, { status: 400 });
      }
      const invalidAgent = validateAuthLoginCompletionAgent(agentId, executorId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.completeAgentAuthLogin(agentId, sessionId, code, executorId));
    } catch (error) {
      if (error instanceof AgentIntegrationError && error.code === 'AUTH_LOGIN_SESSION_MISMATCH') {
        return Response.json({ error: error.message }, { status: 409 });
      }
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/agents': { GET: getAgents },
    '/api/v1/agents/auth': { GET: getAgentAuth },
    '/api/v1/agents/readiness': { GET: getAgentReadiness },
    '/api/v1/agents/auth/login': {
      GET: getAgentAuthLoginStatus,
      POST: withJsonBody(postAgentAuthLogin),
    },
    '/api/v1/agents/auth/login/complete': { POST: withJsonBody(postAgentAuthComplete) },
  };
}
