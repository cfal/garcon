// API provider routes manage persisted compatible endpoint configuration.

import { withJsonBody } from '../lib/json-route.js';

export default function createApiProviderRoutes(apiProviders) {
  async function getApiProviders() {
    try {
      return Response.json({ apiProviders: apiProviders.getCatalog() });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function postApiProvider(body) {
    try {
      const result = await apiProviders.create(body);
      return Response.json(result, { status: 201 });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function putApiProvider(body, _request, url) {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      return Response.json(await apiProviders.update(id, body));
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
      await apiProviders.delete(id);
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function testApiProvider(body) {
    try {
      return Response.json(await apiProviders.test(body));
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  }

  async function discoverApiProviderModels(body) {
    try {
      return Response.json(await apiProviders.discoverModels(body));
    } catch (error) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
  }

  return {
    '/api/v1/api-providers': {
      GET: getApiProviders,
      POST: withJsonBody(postApiProvider),
      PUT: withJsonBody(putApiProvider),
      DELETE: deleteApiProvider,
    },
    '/api/v1/api-providers/test': { POST: withJsonBody(testApiProvider) },
    '/api/v1/api-providers/models': { POST: withJsonBody(discoverApiProviderModels) },
  };
}
