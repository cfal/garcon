// API provider routes manage persisted compatible endpoint configuration.

import { withJsonBody } from '../lib/json-route.js';
import type { HttpRouteContext, RouteMap } from '../lib/http-route-types.js';
import type { ApiProviderService } from '../api-providers/service.js';
import { isApiProviderId, type ApiProviderInput, type ApiProviderModelDiscoveryRequest } from '../../../common/api-providers.js';
import type { ModelCatalogResponseCache } from '../agents/model-catalog-cache.js';
import { jsonErrorFromCorruptStateFile } from './route-helpers.js';
import { executorIdFromUrl } from './executor-target.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { AgentCallError } from '@garcon/server-agent-interface';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import { AtomicJsonWriteError } from '../../common/json-file-store.js';

function apiProviderStorageError(error: unknown): Response {
  if (error instanceof AtomicJsonWriteError && error.renamed) {
    return jsonErrorFromUnknown(new DomainError('API_PROVIDER_STORAGE_UNAVAILABLE',
      'Provider save durability is unknown. Reload after checking controller configuration.', 503));
  }
  return apiProviderError(error);
}

function apiProviderError(error: unknown): Response {
  if (error instanceof DomainError || error instanceof AgentCallError) return jsonErrorFromUnknown(error);
  const corruptStateResponse = jsonErrorFromCorruptStateFile(error);
  if (corruptStateResponse) return corruptStateResponse;
  return jsonErrorFromUnknown(error, 400);
}

export default function createApiProviderRoutes(
  apiProviders: ApiProviderService,
  responseCache: ModelCatalogResponseCache,
): RouteMap {
  async function postApiProvider(body: ApiProviderInput, _request: Request, url: URL): Promise<Response> {
    try {
      const result = await apiProviders.create(body, executorIdFromUrl(url));
      responseCache.clear();
      return Response.json(result, { status: 201 });
    } catch (error) {
      return apiProviderStorageError(error);
    }
  }

  async function putApiProvider(body: Partial<ApiProviderInput>, _request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return jsonError('id query parameter is required', 400);
    }
    try {
      const result = await apiProviders.update(id, body);
      responseCache.clear();
      return Response.json(result);
    } catch (error) {
      return apiProviderStorageError(error);
    }
  }

  async function deleteApiProvider(_request: Request, url: URL): Promise<Response> {
    const id = url.searchParams.get('id');
    if (!id) {
      return jsonError('id query parameter is required', 400);
    }
    try {
      if (url.searchParams.get('acknowledgeSharedImpact') !== 'true') {
        throw new ValidationDomainError('Deleting a shared profile requires acknowledgement of its impact on other workspaces.');
      }
      await apiProviders.delete(id);
      responseCache.clear();
      return Response.json({ success: true });
    } catch (error) {
      return apiProviderStorageError(error);
    }
  }

  async function getManagement(): Promise<Response> {
    try {
      return Response.json(apiProviders.management());
    } catch (error) {
      return apiProviderStorageError(error);
    }
  }

  async function changeAssignment(request: Request, url: URL, _server?: unknown, context?: HttpRouteContext): Promise<Response> {
    try {
      const id = url.searchParams.get('apiProviderId');
      if (!isApiProviderId(id)) throw new ValidationDomainError('Invalid provider ID');
      const executorId = executorIdFromUrl(url);
      const result = request.method === 'PUT'
        ? await apiProviders.assign(executorId, id, context?.assertCurrent)
        : await apiProviders.unassign(executorId, id, context?.assertCurrent);
      responseCache.clear();
      return Response.json(result);
    } catch (error) {
      return apiProviderStorageError(error);
    }
  }

  async function testApiProvider(body: ApiProviderInput, _request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await apiProviders.test(body, executorIdFromUrl(url)));
    } catch (error) {
      return apiProviderStorageError(error);
    }
  }

  async function discoverApiProviderModels(body: ApiProviderModelDiscoveryRequest, _request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await apiProviders.discoverModels(body, executorIdFromUrl(url)));
    } catch (error) {
      return apiProviderError(error);
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
