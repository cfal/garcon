import { beforeEach, describe, expect, it, mock } from 'bun:test';

const parseJsonBody = mock(() => Promise.resolve({}));
class MalformedJsonError extends Error {
  constructor() { super('Malformed JSON'); this.name = 'MalformedJsonError'; }
}

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
  MalformedJsonError,
}));

import createAgentRoutes from '../agents.js';
import createApiProviderRoutes from '../api-providers.js';
import { ModelCatalogResponseCache } from '../model-catalog-cache.js';
import { AgentAuthLoginSessionError } from '../../agents/auth-login.js';

describe('agent auth login routes', () => {
  const agents = {
    hasAgent: mock(() => true),
    supportsAuthLogin: mock(() => true),
    supportsAuthLoginCompletion: mock(() => true),
    getAgentAuthStatus: mock(() => Promise.resolve(null)),
    getAgentAuthStatusMap: mock(() => Promise.resolve({})),
    getAgentReadinessMap: mock(() => Promise.resolve({})),
    getAgentCatalogEntries: mock(() => Promise.resolve([])),
    launchAgentAuthLogin: mock(() => Promise.resolve({
      launched: true,
      alreadyRunning: false,
      sessionId: 'session-a',
    })),
    completeAgentAuthLogin: mock(() => Promise.resolve({ completed: true, sessionId: 'session-a' })),
    getAgentAuthLoginStatus: mock(() => Promise.resolve({
      running: true,
      sessionId: 'session-a',
      deviceAuth: { url: 'https://example.test/device', code: 'AAAA-BBBBB' },
    })),
  };
  const apiProviders = {
    getCatalog: mock(() => []),
    create: mock((input) => Promise.resolve({ id: 'custom_one', ...input })),
    update: mock((id, input) => Promise.resolve({ id, ...input })),
    delete: mock(() => Promise.resolve(undefined)),
    test: mock(() => Promise.resolve({ success: true })),
    discoverModels: mock(() => Promise.resolve({ success: true, models: [{ value: 'example', label: 'Example' }] })),
  };
  const responseCache = new ModelCatalogResponseCache();
  const routes = {
    ...createAgentRoutes({ agents, apiProviders }),
    ...createApiProviderRoutes(apiProviders, responseCache),
  };

  beforeEach(() => {
    parseJsonBody.mockClear();
    for (const fn of [...Object.values(agents), ...Object.values(apiProviders)]) {
      if (typeof fn?.mockClear === 'function') fn.mockClear();
    }
    responseCache.clear();
  });

  it('launches Claude login via the agent auth route', async () => {
    parseJsonBody.mockResolvedValueOnce({ agentId: 'claude' });
    const handler = routes['/api/v1/agents/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ launched: true, alreadyRunning: false, sessionId: 'session-a' });
    expect(agents.launchAgentAuthLogin).toHaveBeenCalledWith('claude');
  });

  it('completes Claude browser-code login via the agent auth route', async () => {
    parseJsonBody.mockResolvedValueOnce({
      agentId: 'claude',
      sessionId: 'session-a',
      code: 'test-code',
    });
    const handler = routes['/api/v1/agents/auth/login/complete'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login/complete', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ completed: true, sessionId: 'session-a' });
    expect(agents.completeAgentAuthLogin).toHaveBeenCalledWith('claude', 'session-a', 'test-code');
  });

  it('returns the typed active login session contract', async () => {
    const handler = routes['/api/v1/agents/auth/login'].GET;
    const request = new Request('http://localhost/api/v1/agents/auth/login?agent=codex');

    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      running: true,
      sessionId: 'session-a',
      deviceAuth: { url: 'https://example.test/device', code: 'AAAA-BBBBB' },
    });
    expect(agents.getAgentAuthLoginStatus).toHaveBeenCalledWith('codex');
  });

  it('validates the missing agent query for login status', async () => {
    const handler = routes['/api/v1/agents/auth/login'].GET;
    const request = new Request('http://localhost/api/v1/agents/auth/login');

    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('agent is required');
    expect(agents.getAgentAuthLoginStatus).not.toHaveBeenCalled();
  });

  it('returns a client error for unknown login-status agents', async () => {
    agents.hasAgent.mockImplementationOnce(() => false);
    const handler = routes['/api/v1/agents/auth/login'].GET;
    const request = new Request('http://localhost/api/v1/agents/auth/login?agent=unknown');

    const response = await handler(request, new URL(request.url));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Unknown agent: unknown');
    expect(agents.getAgentAuthLoginStatus).not.toHaveBeenCalled();
  });

  it('returns a client error for agents without UI login support', async () => {
    agents.supportsAuthLogin.mockImplementationOnce(() => false);
    parseJsonBody.mockResolvedValueOnce({ agentId: 'amp' });
    const handler = routes['/api/v1/agents/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Auth login is not supported for agent: amp');
    expect(agents.launchAgentAuthLogin).not.toHaveBeenCalled();
  });

  it('returns conflict when completion no longer owns the login session', async () => {
    agents.completeAgentAuthLogin.mockImplementationOnce(() => {
      throw new AgentAuthLoginSessionError('No matching pending auth login for agent: claude');
    });
    parseJsonBody.mockResolvedValueOnce({
      agentId: 'claude',
      sessionId: 'stale-session',
      code: 'test-code',
    });
    const handler = routes['/api/v1/agents/auth/login/complete'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login/complete', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('No matching pending auth login for agent: claude');
  });

  it('returns a client error when the agent does not support auth completion', async () => {
    agents.supportsAuthLoginCompletion.mockImplementationOnce(() => false);
    parseJsonBody.mockResolvedValueOnce({
      agentId: 'codex',
      sessionId: 'session-a',
      code: 'test-code',
    });
    const handler = routes['/api/v1/agents/auth/login/complete'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login/complete', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Auth login completion is not supported for agent: codex');
    expect(agents.completeAgentAuthLogin).not.toHaveBeenCalled();
  });

  it('validates missing code for auth completion', async () => {
    parseJsonBody.mockResolvedValueOnce({ agentId: 'claude' });
    const handler = routes['/api/v1/agents/auth/login/complete'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login/complete', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('code is required');
    expect(agents.completeAgentAuthLogin).not.toHaveBeenCalled();
  });

  it('validates missing session ownership for auth completion', async () => {
    parseJsonBody.mockResolvedValueOnce({ agentId: 'claude', code: 'test-code' });
    const handler = routes['/api/v1/agents/auth/login/complete'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login/complete', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('sessionId is required');
    expect(agents.completeAgentAuthLogin).not.toHaveBeenCalled();
  });

  it('returns an error response when auth launch fails', async () => {
    parseJsonBody.mockResolvedValueOnce({ agentId: 'codex' });
    const handler = routes['/api/v1/agents/auth/login'].POST;
    agents.launchAgentAuthLogin.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('spawn failed');
  });

  it('validates missing agentId for auth launch', async () => {
    parseJsonBody.mockResolvedValueOnce({});
    const handler = routes['/api/v1/agents/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('agentId is required');
    expect(agents.launchAgentAuthLogin).not.toHaveBeenCalled();
  });

  it('returns the clean agent/API provider catalog', async () => {
    agents.getAgentCatalogEntries.mockImplementationOnce(() => Promise.resolve([{ id: 'claude', kind: 'agent', models: [] }]));
    apiProviders.getCatalog.mockImplementationOnce(() => [{ id: 'zai', endpoints: [] }]);
    const handler = routes['/api/v1/agents'].GET;

    const response = await handler(new Request('http://localhost/api/v1/agents'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      agents: [{ id: 'claude', kind: 'agent', models: [] }],
      apiProviders: [{ id: 'zai', endpoints: [] }],
    });
  });

  it('creates API providers through the API provider route', async () => {
    const input = {
      templateId: 'custom',
      label: 'Example',
      endpoint: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        capabilities: { chatCompletions: false, responses: true },
        defaultModel: 'example',
        models: [],
      },
    };
    parseJsonBody.mockImplementationOnce(() => Promise.resolve(input));
    const handler = routes['/api/v1/api-providers'].POST;

    const response = await handler(new Request('http://localhost/api/v1/api-providers', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(apiProviders.create).toHaveBeenCalledWith(input);
    expect(body.id).toBe('custom_one');
  });

  it('tests API providers without persisting them', async () => {
    const input = {
      templateId: 'custom',
      label: 'Probe',
      endpoint: {
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.example.test/anthropic',
        defaultModel: 'example',
        models: [],
      },
    };
    parseJsonBody.mockImplementationOnce(() => Promise.resolve(input));
    apiProviders.test.mockImplementationOnce(() => Promise.resolve({ success: true }));
    const handler = routes['/api/v1/api-providers/test'].POST;

    const response = await handler(new Request('http://localhost/api/v1/api-providers/test', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(apiProviders.test).toHaveBeenCalledWith(input);
    expect(apiProviders.create).not.toHaveBeenCalled();
  });

  it('discovers API provider models without persisting them', async () => {
    const input = {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      modelDiscovery: 'openai-models',
    };
    parseJsonBody.mockImplementationOnce(() => Promise.resolve(input));
    const handler = routes['/api/v1/api-providers/models'].POST;

    const response = await handler(new Request('http://localhost/api/v1/api-providers/models', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, models: [{ value: 'example', label: 'Example' }] });
    expect(apiProviders.discoverModels).toHaveBeenCalledWith(input);
    expect(apiProviders.create).not.toHaveBeenCalled();
  });

  async function populateCatalogCache() {
    await responseCache.getSnapshot({ agents, apiProviders });
  }

  const providerInput = {
    templateId: 'custom',
    label: 'Example',
    endpoint: {
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      capabilities: { chatCompletions: false, responses: true },
      defaultModel: 'example',
      models: [],
    },
  };

  it('clears the model catalog response cache after creating a provider', async () => {
    await populateCatalogCache();
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);

    parseJsonBody.mockImplementationOnce(() => Promise.resolve(providerInput));
    const handler = routes['/api/v1/api-providers'].POST;
    const response = await handler(new Request('http://localhost/api/v1/api-providers', { method: 'POST' }));
    expect(response.status).toBe(201);

    await responseCache.getSnapshot({ agents, apiProviders });
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(2);
  });

  it('clears the model catalog response cache after updating a provider', async () => {
    await populateCatalogCache();
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);

    parseJsonBody.mockImplementationOnce(() => Promise.resolve(providerInput));
    const handler = routes['/api/v1/api-providers'].PUT;
    const request = new Request('http://localhost/api/v1/api-providers?id=custom_one', { method: 'PUT' });
    const response = await handler(request, new URL(request.url));
    expect(response.status).toBe(200);

    await responseCache.getSnapshot({ agents, apiProviders });
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(2);
  });

  it('clears the model catalog response cache after deleting a provider', async () => {
    await populateCatalogCache();
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);

    const handler = routes['/api/v1/api-providers'].DELETE;
    const request = new Request('http://localhost/api/v1/api-providers?id=custom_one', { method: 'DELETE' });
    const response = await handler(request, new URL(request.url));
    expect(response.status).toBe(200);

    await responseCache.getSnapshot({ agents, apiProviders });
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(2);
  });

  it('does not clear the cache when testing or discovering provider models', async () => {
    await populateCatalogCache();
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);

    parseJsonBody.mockImplementationOnce(() => Promise.resolve(providerInput));
    await routes['/api/v1/api-providers/test'].POST(
      new Request('http://localhost/api/v1/api-providers/test', { method: 'POST' }),
    );

    parseJsonBody.mockImplementationOnce(() => Promise.resolve({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-test',
      modelDiscovery: 'openai-models',
    }));
    await routes['/api/v1/api-providers/models'].POST(
      new Request('http://localhost/api/v1/api-providers/models', { method: 'POST' }),
    );

    await responseCache.getSnapshot({ agents, apiProviders });
    expect(agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);
  });
});
