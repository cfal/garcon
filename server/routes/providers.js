// Harness and API provider routes. Harness routes expose native auth and
// readiness; API provider routes manage persisted compatible endpoints.

import { parseJsonBody } from '../lib/http-request.js';

export default function createProviderRoutes(providers) {
  async function getHarnesses() {
    try {
      return Response.json(await providers.getHarnessCatalog());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getHarnessAuth(_request, url) {
    const harnessId = url.searchParams.get('harness');
    try {
      if (harnessId) {
        const status = await providers.getHarnessAuthStatus(harnessId);
        if (!status) {
          return Response.json({ error: `Unknown harness: ${harnessId}` }, { status: 400 });
        }
        return Response.json({ [harnessId]: status });
      }
      return Response.json(await providers.getHarnessAuthStatusMap());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getHarnessReadiness() {
    try {
      return Response.json(await providers.getHarnessReadinessMap());
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function postHarnessAuthLogin(request) {
    try {
      const body = await parseJsonBody(request);
      const harnessId = typeof body?.harnessId === 'string' ? body.harnessId : '';
      if (!harnessId) {
        return Response.json({ error: 'harnessId is required' }, { status: 400 });
      }
      return Response.json(await providers.launchHarnessAuthLogin(harnessId));
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
    '/api/v1/harnesses': { GET: getHarnesses },
    '/api/v1/harnesses/auth': { GET: getHarnessAuth },
    '/api/v1/harnesses/readiness': { GET: getHarnessReadiness },
    '/api/v1/harnesses/auth/login': { POST: postHarnessAuthLogin },
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
