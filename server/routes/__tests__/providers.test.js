import { beforeEach, describe, expect, it, mock } from 'bun:test';

const parseJsonBody = mock(() => Promise.resolve({}));

mock.module('../../lib/http-request.js', () => ({
  parseJsonBody,
}));

import createProviderRoutes from '../providers.js';

describe('harness auth login routes', () => {
  const providers = {
    getHarnessAuthStatus: mock(() => Promise.resolve(null)),
    getHarnessAuthStatusMap: mock(() => Promise.resolve({})),
    getHarnessReadinessMap: mock(() => Promise.resolve({})),
    getHarnessCatalog: mock(() => Promise.resolve({ harnesses: [], apiProviders: [] })),
    launchHarnessAuthLogin: mock(() => Promise.resolve({ launched: true, alreadyRunning: false })),
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

  it('launches Claude login via the harness auth route', async () => {
    parseJsonBody.mockResolvedValueOnce({ harnessId: 'claude' });
    const handler = routes['/api/v1/harnesses/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/harnesses/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ launched: true, alreadyRunning: false });
    expect(providers.launchHarnessAuthLogin).toHaveBeenCalledWith('claude');
  });

  it('returns an error response when auth launch fails', async () => {
    parseJsonBody.mockResolvedValueOnce({ harnessId: 'codex' });
    const handler = routes['/api/v1/harnesses/auth/login'].POST;
    providers.launchHarnessAuthLogin.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const response = await handler(new Request('http://localhost/api/v1/harnesses/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('spawn failed');
  });

  it('validates missing harnessId for auth launch', async () => {
    parseJsonBody.mockResolvedValueOnce({});
    const handler = routes['/api/v1/harnesses/auth/login'].POST;

    const response = await handler(new Request('http://localhost/api/v1/harnesses/auth/login', { method: 'POST' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('harnessId is required');
    expect(providers.launchHarnessAuthLogin).not.toHaveBeenCalled();
  });

  it('returns the clean harness/API provider catalog', async () => {
    providers.getHarnessCatalog.mockImplementationOnce(() => Promise.resolve({
      harnesses: [{ id: 'claude', kind: 'harness', models: [] }],
      apiProviders: [{ id: 'zai', endpoints: [] }],
    }));
    const handler = routes['/api/v1/harnesses'].GET;

    const response = await handler(new Request('http://localhost/api/v1/harnesses'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      harnesses: [{ id: 'claude', kind: 'harness', models: [] }],
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
