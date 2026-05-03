// Harness and API provider routes. Harness routes expose native auth and
// readiness; API provider routes manage persisted compatible endpoints.

import { launchProviderAuthLogin } from '../providers/auth-login.js';
import { parseJsonBody } from '../lib/http-request.js';

const UI_LOGIN_HARNESSES = new Set(['claude', 'codex']);

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

  async function postHarnessAuthLogin(harnessId) {
    if (!UI_LOGIN_HARNESSES.has(harnessId)) {
      return Response.json({ error: `Auth login is not supported for harness: ${harnessId}` }, { status: 400 });
    }
    try {
      return Response.json(await launchProviderAuthLogin(harnessId));
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

  return {
    '/api/v1/harnesses': { GET: getHarnesses },
    '/api/v1/harnesses/auth': { GET: getHarnessAuth },
    '/api/v1/harnesses/readiness': { GET: getHarnessReadiness },
    '/api/v1/harnesses/claude/auth/login': { POST: () => postHarnessAuthLogin('claude') },
    '/api/v1/harnesses/codex/auth/login': { POST: () => postHarnessAuthLogin('codex') },
    '/api/v1/api-providers': {
      GET: getApiProviders,
      POST: postApiProvider,
      PUT: putApiProvider,
      DELETE: deleteApiProvider,
    },
    '/api/v1/api-providers/test': { POST: testApiProvider },
  };
}
