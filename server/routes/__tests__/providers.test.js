import { beforeEach, describe, expect, it, mock } from 'bun:test';

const parseJsonBody = mock(() => Promise.resolve({}));

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
}));

import createProviderRoutes from '../providers.js';

describe('agent auth login routes', () => {
  const providers = {
    getAgentAuthStatus: mock(() => Promise.resolve(null)),
    getAgentAuthStatusMap: mock(() => Promise.resolve({})),
    getAgentReadinessMap: mock(() => Promise.resolve({})),
    getAgentCatalog: mock(() => Promise.resolve({ agents: [], apiProviders: [] })),
    launchAgentAuthLogin: mock(() => Promise.resolve({ launched: true, alreadyRunning: false })),
    getApiProviderCatalog: mock(() => []),
    createApiProvider: mock((input) => Promise.resolve({ id: 'custom_one', ...input })),
    updateApiProvider: mock((id, input) => Promise.resolve({ id, ...input })),
    deleteApiProvider: mock(() => Promise.resolve(undefined)),
    testApiProvider: mock(() => Promise.resolve({ success: true })),
    discoverApiProviderModels: mock(() => Promise.resolve({ success: true, models: [{ value: 'example', label: 'Example' }] })),
  };
  const routes = createProviderRoutes(providers);

  beforeEach(() => {
    parseJsonBody.mockClear();
    for (const fn of Object.values(providers)) {
      if (typeof fn?.mockClear === 'function') fn.mockClear();
    }
  });

  it('launches Claude login via the agent auth route', async () => {
    parseJsonBody.mockResolvedValueOnce({ agentId: 'claude' });
    const handler = routes['/api/v1/agents/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/agents/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ launched: true, alreadyRunning: false });
    expect(providers.launchAgentAuthLogin).toHaveBeenCalledWith('claude');
  });

  it('returns an error response when auth launch fails', async () => {
    parseJsonBody.mockResolvedValueOnce({ agentId: 'codex' });
    const handler = routes['/api/v1/agents/auth/login'].POST;
    providers.launchAgentAuthLogin.mockImplementationOnce(() => {
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
    expect(providers.launchAgentAuthLogin).not.toHaveBeenCalled();
  });

  it('returns the clean agent/API provider catalog', async () => {
    providers.getAgentCatalog.mockImplementationOnce(() => Promise.resolve({
      agents: [{ id: 'claude', kind: 'agent', models: [] }],
      apiProviders: [{ id: 'zai', endpoints: [] }],
    }));
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
    expect(providers.createApiProvider).toHaveBeenCalledWith(input);
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
    providers.testApiProvider.mockImplementationOnce(() => Promise.resolve({ success: true }));
    const handler = routes['/api/v1/api-providers/test'].POST;

    const response = await handler(new Request('http://localhost/api/v1/api-providers/test', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(providers.testApiProvider).toHaveBeenCalledWith(input);
    expect(providers.createApiProvider).not.toHaveBeenCalled();
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
    expect(providers.discoverApiProviderModels).toHaveBeenCalledWith(input);
    expect(providers.createApiProvider).not.toHaveBeenCalled();
  });
});
