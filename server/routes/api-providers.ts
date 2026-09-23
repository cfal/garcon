// API provider routes manage persisted compatible endpoint configuration.

import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { ApiProviderInput, ApiProviderService } from '../api-providers/service.js';
import { isApiProviderId, type ApiProviderModelDiscoveryRequest } from '../../common/api-providers.js';
import type { ModelCatalogResponseCache } from './model-catalog-cache.js';
import { errorMessage, jsonErrorFromCorruptStateFile } from './route-helpers.js';
import { executionNodeIdFromUrl } from './node-target.js';
import { DomainError, ValidationDomainError } from '../lib/domain-error.js';
import { AgentCallError } from '@garcon/server-agent-interface';
import { jsonErrorFromUnknown } from '../lib/http-error.js';

function apiProviderError(error: unknown): Response {
  if (error instanceof DomainError || error instanceof AgentCallError) return jsonErrorFromUnknown(error);
  const corruptStateResponse = jsonErrorFromCorruptStateFile(error);
  if (corruptStateResponse) return corruptStateResponse;
  return Response.json({ error: errorMessage(error) }, { status: 400 });
}

function apiProviderDiscoveryError(error: unknown): Response {
  if (error instanceof DomainError || error instanceof AgentCallError) return jsonErrorFromUnknown(error);
  const corruptStateResponse = jsonErrorFromCorruptStateFile(error);
  if (corruptStateResponse) return corruptStateResponse;
  return Response.json({ success: false, error: errorMessage(error) }, { status: 400 });
}

export default function createApiProviderRoutes(
  apiProviders: ApiProviderService,
  responseCache: ModelCatalogResponseCache,
): RouteMap {
  async function postApiProvider(body: ApiProviderInput, _request: Request, url: URL): Promise<Response> {
    try {
      const result = await apiProviders.create(body, executionNodeIdFromUrl(url));
      responseCache.clear();
      return Response.json(result, { status: 201 });
    } catch (error) {
      return apiProviderError(error);
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
      return apiProviderError(error);
    }
  }

  async function deleteApiProvider(_request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return Response.json({ error: 'id query parameter is required' }, { status: 400 });
    }
    try {
      if (url.searchParams.get('acknowledgeSharedImpact') !== 'true') {
        throw new ValidationDomainError('Deleting a shared profile requires acknowledgement of its impact on other workspaces.');
      }
      await apiProviders.delete(id);
      responseCache.clear();
      return Response.json({ success: true });
    } catch (error) {
      return apiProviderError(error);
    }
  }

  async function getManagement(): Promise<Response> {
    try {
      return Response.json(apiProviders.management());
    } catch (error) {
      return apiProviderError(error);
    }
  }

  async function changeAssignment(request: Request, url: URL): Promise<Response> {
    try {
      const id = url.searchParams.get('apiProviderId');
      if (!isApiProviderId(id)) throw new ValidationDomainError('Invalid provider ID');
      const nodeId = executionNodeIdFromUrl(url);
      const result = request.method === 'PUT'
        ? await apiProviders.assign(nodeId, id)
        : await apiProviders.unassign(nodeId, id);
      responseCache.clear();
      return Response.json(result);
    } catch (error) {
      return apiProviderError(error);
    }
  }

  async function testApiProvider(body: ApiProviderInput, _request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await apiProviders.test(body, executionNodeIdFromUrl(url)));
    } catch (error) {
      return apiProviderError(error);
    }
  }

  async function discoverApiProviderModels(body: ApiProviderModelDiscoveryRequest, _request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await apiProviders.discoverModels(body, executionNodeIdFromUrl(url)));
    } catch (error) {
      return apiProviderDiscoveryError(error);
    }
  }

  return {
    '/api/v1/api-providers': {
      GET: getManagement,
      POST: withJsonBody(postApiProvider),
      PUT: withJsonBody(putApiProvider),
      DELETE: deleteApiProvider,
    },
    '/api/v1/api-provider-assignments': {
      GET: getManagement,
      PUT: changeAssignment,
      DELETE: changeAssignment,
    },
    '/api/v1/api-providers/test': { POST: withJsonBody(testApiProvider) },
    '/api/v1/api-providers/models': { POST: withJsonBody(discoverApiProviderModels) },
  };
}
