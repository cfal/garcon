// Agent routes expose runtime catalog, auth, and readiness state.

import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ApiProviderService } from '../api-providers/service.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';

interface AgentRouteDeps {
  agents: AgentRegistryServiceContract;
  apiProviders: ApiProviderService;
}

export default function createAgentRoutes({ agents, apiProviders }: AgentRouteDeps): RouteMap {
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

  async function getAgentAuth(_request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    try {
      if (agentId) {
        const status = await agents.getAgentAuthStatus(agentId);
        if (!status) {
          return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
        }
        return Response.json({ [agentId]: status });
      }
      return Response.json(await agents.getAgentAuthStatusMap());
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getAgentReadiness(): Promise<Response> {
    try {
      return Response.json(await agents.getAgentReadinessMap());
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postAgentAuthLogin(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      if (!agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      return Response.json(await agents.launchAgentAuthLogin(agentId));
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getAgentAuthLoginStatus(_request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    if (!agentId) {
      return Response.json({ error: 'agent is required' }, { status: 400 });
    }
    try {
      return Response.json(await agents.getAgentAuthLoginStatus(agentId));
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function postAgentAuthComplete(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      const code = typeof input.code === 'string' ? input.code : '';
      if (!agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      if (!code.trim()) {
        return Response.json({ error: 'code is required' }, { status: 400 });
      }
      return Response.json(await agents.completeAgentAuthLogin(agentId, code));
    } catch (error) {
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
