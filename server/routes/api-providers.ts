// API provider routes manage persisted compatible endpoint configuration.

import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { ApiProviderInput, ApiProviderService } from '../api-providers/service.js';
import type { ApiProviderModelDiscoveryRequest } from '../../common/api-providers.js';
import type { ModelCatalogResponseCache } from './model-catalog-cache.js';
import { errorMessage } from './route-helpers.js';

export default function createApiProviderRoutes(
  apiProviders: ApiProviderService,
  responseCache: ModelCatalogResponseCache,
): RouteMap {
  async function postApiProvider(body: ApiProviderInput): Promise<Response> {
    try {
      const result = await apiProviders.create(body);
      responseCache.clear();
      return Response.json(result, { status: 201 });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }
  }

  async function putApiProvider(body: Partial<ApiProviderInput>, _request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      const result = await apiProviders.update(id, body);
      responseCache.clear();
      return Response.json(result);
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }
  }

  async function deleteApiProvider(_request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      await apiProviders.delete(id);
      responseCache.clear();
      return Response.json({ success: true });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }
  }

  async function testApiProvider(body: ApiProviderInput): Promise<Response> {
    try {
      return Response.json(await apiProviders.test(body));
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 });
    }
  }

  async function discoverApiProviderModels(body: ApiProviderModelDiscoveryRequest): Promise<Response> {
    try {
      return Response.json(await apiProviders.discoverModels(body));
    } catch (error) {
      return Response.json({ success: false, error: errorMessage(error) }, { status: 400 });
    }
  }

  return {
    '/api/v1/api-providers': {
      POST: withJsonBody(postApiProvider),
      PUT: withJsonBody(putApiProvider),
      DELETE: deleteApiProvider,
    },
    '/api/v1/api-providers/test': { POST: withJsonBody(testApiProvider) },
    '/api/v1/api-providers/models': { POST: withJsonBody(discoverApiProviderModels) },
  };
}
