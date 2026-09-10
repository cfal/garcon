// Agent routes expose runtime catalog, auth, and readiness state.

import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ApiProviderService } from '../api-providers/service.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';
import { isDomainError } from '../lib/domain-error.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { cancelledRequestResponse } from '../lib/http-error.js';

interface AgentRouteDeps {
  agents: Pick<AgentRegistryServiceContract, 'hasAgent' | 'supportsAuthLogin' | 'supportsAuthLoginCompletion'
    | 'getAgentCatalogEntries' | 'getAgentAuthStatus' | 'getAgentAuthStatusMap' | 'getAgentReadinessMap'
    | 'launchAgentAuthLogin' | 'completeAgentAuthLogin' | 'getAgentAuthLoginStatus'>;
  apiProviders: Pick<ApiProviderService, 'getCatalog'>;
}

export default function createAgentRoutes({ agents, apiProviders }: AgentRouteDeps): RouteMap {
  function validateAuthLoginAgent(agentId: string): Response | null {
    if (!agents.hasAgent(agentId)) {
      return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
    }
    if (!agents.supportsAuthLogin(agentId)) {
      return Response.json({ error: `Auth login is not supported for agent: ${agentId}` }, { status: 400 });
    }
    return null;
  }

  function validateAuthLoginCompletionAgent(agentId: string): Response | null {
    if (!agents.hasAgent(agentId)) {
      return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
    }
    if (!agents.supportsAuthLoginCompletion(agentId)) {
      return Response.json(
        { error: `Auth login completion is not supported for agent: ${agentId}` },
        { status: 400 },
      );
    }
    return null;
  }

  async function getAgents(): Promise<Response> {
    try {
      return Response.json({
        agents: await agents.getAgentCatalogEntries(),
        apiProviders: apiProviders.getCatalog(),
      });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getAgentAuth(request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    try {
      if (agentId) {
        const status = await agents.getAgentAuthStatus(agentId, request.signal);
        request.signal.throwIfAborted();
        if (!status) {
          return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
        }
        return Response.json({ [agentId]: status });
      }
      const statuses = await agents.getAgentAuthStatusMap(request.signal);
      request.signal.throwIfAborted();
      return Response.json(statuses);
    } catch (error) {
      return cancelledRequestResponse(request, error)
        ?? Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getAgentReadiness(request: Request): Promise<Response> {
    try {
      const readiness = await agents.getAgentReadinessMap(undefined, request.signal);
      request.signal.throwIfAborted();
      return Response.json(readiness);
    } catch (error) {
      return cancelledRequestResponse(request, error)
        ?? Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postAgentAuthLogin(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      if (!agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      const invalidAgent = validateAuthLoginAgent(agentId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.launchAgentAuthLogin(agentId));
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getAgentAuthLoginStatus(request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    const expectedSessionId = url.searchParams.get('session') ?? undefined;
    if (!agentId) {
      return Response.json({ error: 'agent is required' }, { status: 400 });
    }
    const invalidAgent = validateAuthLoginAgent(agentId);
    if (invalidAgent) return invalidAgent;
    try {
      const status = await agents.getAgentAuthLoginStatus(agentId, expectedSessionId, request.signal);
      request.signal.throwIfAborted();
      return Response.json(status);
    } catch (error) {
      return cancelledRequestResponse(request, error)
        ?? Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postAgentAuthComplete(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
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
      const invalidAgent = validateAuthLoginCompletionAgent(agentId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.completeAgentAuthLogin(agentId, sessionId, code));
    } catch (error) {
      if (error instanceof AgentIntegrationError && error.code === 'AUTH_LOGIN_SESSION_MISMATCH') {
        return Response.json({ error: error.message }, { status: 409 });
      }
      if (isDomainError(error)) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json({ error: errorMessage(error) }, { status: 500 });
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
