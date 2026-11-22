// Agent routes expose runtime catalog, auth, and readiness state.

import { withJsonBody } from '../lib/json-route.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ModelCatalogResponseCache } from '../agents/model-catalog-cache.js';
import type { ApiProviderService } from '../api-providers/service.js';
import { asJsonBody, type JsonBody } from './route-helpers.js';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { executorIdFromUrl, executorIdFromValue, onLoginInstance } from './executor-target.js';
import { LOGIN_INSTANCE_QUERY, type AgentAuthLoginHttpStatus } from '../../../common/agent-auth.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';

interface AgentRouteDeps {
  agents: AgentRegistryServiceContract;
  apiProviders: ApiProviderService;
  responseCache: ModelCatalogResponseCache;
  readyInstanceId(executorId: string): string;
}

export default function createAgentRoutes({ agents, apiProviders, responseCache, readyInstanceId }: AgentRouteDeps): RouteMap {
  function validateAuthLoginAgent(agentId: string, executorId: string): Response | null {
    agents.assertExecutorReady(executorId);
    if (!agents.hasAgent(agentId, executorId)) {
      return jsonError(`Unknown agent: ${agentId}`, 400);
    }
    if (!agents.supportsAuthLogin(agentId, executorId)) {
      return jsonError(`Auth login is not supported for agent: ${agentId}`, 400);
    }
    return null;
  }

  function validateAuthLoginCompletionAgent(agentId: string, executorId: string): Response | null {
    agents.assertExecutorReady(executorId);
    if (!agents.hasAgent(agentId, executorId)) {
      return jsonError(`Unknown agent: ${agentId}`, 400);
    }
    if (!agents.supportsAuthLoginCompletion(agentId, executorId)) {
      return jsonError(`Auth login completion is not supported for agent: ${agentId}`, 400);
    }
    return null;
  }

  async function getAgents(_request: Request, url: URL): Promise<Response> {
    try {
      return Response.json({
        agents: await agents.getAgentCatalogEntries(executorIdFromUrl(url)),
        apiProviders: apiProviders.getCatalog(executorIdFromUrl(url)),
      });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAgentAuth(_request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    try {
      const executorId = executorIdFromUrl(url);
      if (agentId) {
        const status = await onLoginInstance(
          () => readyInstanceId(executorId),
          url.searchParams.get(LOGIN_INSTANCE_QUERY),
          () => agents.getAgentAuthStatus(agentId, executorId),
        );
        if (!status) {
          return jsonError(`Unknown agent: ${agentId}`, 400);
        }
        return Response.json({ [agentId]: status });
      }
      return Response.json(await agents.getAgentAuthStatusMap(executorId));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAgentReadiness(_request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await agents.getAgentReadinessMap(undefined, executorIdFromUrl(url)));
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postAgentAuthLogin(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const executorId = executorIdFromValue(input.executorId);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      if (!agentId) {
        return jsonError('agentId is required', 400);
      }
      const invalidAgent = validateAuthLoginAgent(agentId, executorId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.launchAgentAuthLogin(agentId, executorId));
    } catch (error) {
      if (error instanceof AgentIntegrationError && error.code === 'OPERATION_UNSUPPORTED') {
        return jsonError(error.message, 501, error.code, false);
      }
      return jsonErrorFromUnknown(error);
    }
  }

  async function getAgentAuthLoginStatus(_request: Request, url: URL): Promise<Response> {
    const agentId = url.searchParams.get('agent');
    const expectedSessionId = url.searchParams.get('session') ?? undefined;
    if (!agentId) {
      return jsonError('agent is required', 400);
    }
    try {
      const executorId = executorIdFromUrl(url);
      const invalidAgent = validateAuthLoginAgent(agentId, executorId);
      if (invalidAgent) return invalidAgent;
      const instanceId = readyInstanceId(executorId);
      const status = await onLoginInstance(() => readyInstanceId(executorId), instanceId,
        () => agents.getAgentAuthLoginStatus(agentId, expectedSessionId, executorId));
      if (status.state === 'succeeded') {
        if (status.sessionId === expectedSessionId) responseCache.clear(executorId);
        return Response.json({ ...status, instanceId } satisfies AgentAuthLoginHttpStatus);
      }
      return Response.json(status);
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postAgentAuthComplete(body: JsonBody): Promise<Response> {
    try {
      const input = asJsonBody(body);
      const executorId = executorIdFromValue(input.executorId);
      const agentId = typeof input.agentId === 'string' ? input.agentId : '';
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
      const code = typeof input.code === 'string' ? input.code : '';
      if (!agentId) {
        return jsonError('agentId is required', 400);
      }
      if (!code.trim()) {
        return jsonError('code is required', 400);
      }
      if (!sessionId) {
        return jsonError('sessionId is required', 400);
      }
      const invalidAgent = validateAuthLoginCompletionAgent(agentId, executorId);
      if (invalidAgent) return invalidAgent;
      return Response.json(await agents.completeAgentAuthLogin(agentId, sessionId, code, executorId));
    } catch (error) {
      if (error instanceof AgentIntegrationError && error.code === 'AUTH_LOGIN_SESSION_MISMATCH') {
        return jsonError(error.message, 409, error.code, error.retryable);
      }
      if (error instanceof AgentIntegrationError && error.code === 'AUTH_LOGIN_CODE_INVALID') {
        return jsonError(error.message, 400, error.code, error.retryable);
      }
      return jsonErrorFromUnknown(error);
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
