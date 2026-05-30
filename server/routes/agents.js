// Agent routes expose runtime catalog, auth, and readiness state.

import { parseJsonBody } from '../lib/http-request.js';

export default function createAgentRoutes({ agents, apiProviders }) {
  async function getAgents() {
    try {
      return Response.json({
        agents: await agents.getAgentCatalogEntries(),
        apiProviders: apiProviders.getCatalog(),
      });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getAgentAuth(_request, url) {
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
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getAgentReadiness() {
    try {
      return Response.json(await agents.getAgentReadinessMap());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function postAgentAuthLogin(request) {
    try {
      const body = await parseJsonBody(request);
      const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
      if (!agentId) {
        return Response.json({ error: 'agentId is required' }, { status: 400 });
      }
      return Response.json(await agents.launchAgentAuthLogin(agentId));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return {
    '/api/v1/agents': { GET: getAgents },
    '/api/v1/agents/auth': { GET: getAgentAuth },
    '/api/v1/agents/readiness': { GET: getAgentReadiness },
    '/api/v1/agents/auth/login': { POST: postAgentAuthLogin },
  };
}
