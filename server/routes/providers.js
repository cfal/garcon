// Agent and API provider routes. Agent routes expose native auth and
// readiness; API provider routes manage persisted compatible endpoints.

import { parseJsonBody } from '../lib/http-request.js';

export default function createProviderRoutes(providers) {
  async function getAgents() {
    try {
      return Response.json(await providers.getAgentCatalog());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getAgentAuth(_request, url) {
    const agentId = url.searchParams.get('agent');
    try {
      if (agentId) {
        const status = await providers.getAgentAuthStatus(agentId);
        if (!status) {
          return Response.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
        }
        return Response.json({ [agentId]: status });
      }
      return Response.json(await providers.getAgentAuthStatusMap());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getAgentReadiness() {
    try {
      return Response.json(await providers.getAgentReadinessMap());
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
      return Response.json(await providers.launchAgentAuthLogin(agentId));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getApiProviders() {
    try {
      return Response.json({ apiProviders: providers.getApiProviderCatalog() });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function postApiProvider(request) {
    try {
      const body = await parseJsonBody(request);
      const result = await providers.createApiProvider(body);
      return Response.json(result, { status: 201 });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function putApiProvider(request, url) {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const body = await parseJsonBody(request);
      const result = await providers.updateApiProvider(id, body);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function deleteApiProvider(_request, url) {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      await providers.deleteApiProvider(id);
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function testApiProvider(request) {
    try {
      const body = await parseJsonBody(request);
      const result = await providers.testApiProvider(body);
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function discoverApiProviderModels(request) {
    try {
      const body = await parseJsonBody(request);
      const result = await providers.discoverApiProviderModels(body);
      return Response.json(result);
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
  }

  return {
    '/api/v1/agents': { GET: getAgents },
    '/api/v1/agents/auth': { GET: getAgentAuth },
    '/api/v1/agents/readiness': { GET: getAgentReadiness },
    '/api/v1/agents/auth/login': { POST: postAgentAuthLogin },
    '/api/v1/api-providers': {
      GET: getApiProviders,
      POST: postApiProvider,
      PUT: putApiProvider,
      DELETE: deleteApiProvider,
    },
    '/api/v1/api-providers/test': { POST: testApiProvider },
    '/api/v1/api-providers/models': { POST: discoverApiProviderModels },
  };
}
