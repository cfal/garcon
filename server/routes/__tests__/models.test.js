import { beforeEach, describe, it, expect, mock } from 'bun:test';

import createModelsRoutes from '../models.js';
import { ModelCatalogResponseCache } from '../model-catalog-cache.js';

const agentCatalogEntries = [
  {
    id: 'claude',
    label: 'Claude',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: true,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
    authLoginSupported: true,
    defaultModel: 'opus',
    models: [{ value: 'opus', label: 'Opus', supportsImages: true }],
  },
  {
    id: 'codex',
    label: 'Codex',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: true,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: true,
    defaultModel: 'gpt-5.5',
    models: [
      { value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', supportsImages: true },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', supportsImages: true },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', supportsImages: true },
      { value: 'gpt-5.4', label: 'GPT-5.4', supportsImages: true },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', supportsImages: true },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', supportsImages: false },
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: '',
    models: [],
  },
  {
    id: 'amp',
    label: 'Amp',
    kind: 'agent',
    supportsFork: false,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: 'default',
    models: [{ value: 'default', label: 'Default' }],
  },
  {
    id: 'factory',
    label: 'Factory',
    kind: 'agent',
    supportsFork: false,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: false,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: 'claude-opus-4-6',
    models: [{ value: 'claude-opus-4-6', label: 'Claude Opus 4-6' }],
  },
  {
    id: 'pi',
    label: 'Pi',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: false,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: false,
    acceptsApiProviderEndpoints: false,
    supportedProtocols: [],
    authLoginSupported: false,
    defaultModel: 'github-copilot/gpt-5.4',
    models: [{ value: 'github-copilot/gpt-5.4', label: 'github-copilot: gpt-5.4', supportsImages: true }],
  },
  {
    id: 'direct-anthropic-compatible',
    label: 'Direct (Anthropic)',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['anthropic-messages'],
    authLoginSupported: false,
    defaultModel: '',
    models: [],
  },
  {
    id: 'direct-openai-compatible',
    label: 'Direct (Chat Completions)',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: false,
    defaultModel: '',
    models: [],
  },
  {
    id: 'direct-openai-responses-compatible',
    label: 'Direct (Responses)',
    kind: 'agent',
    supportsFork: true,
    supportsForkAtMessage: true,
    supportsForkWhileRunning: false,
    supportsUpdateProjectPath: true,
    supportsImages: true,
    acceptsApiProviderEndpoints: true,
    supportedProtocols: ['openai-compatible'],
    authLoginSupported: false,
    defaultModel: '',
    models: [],
  },
];

const modelCatalog = {
  agents: {
    getAgentCatalogEntries: mock(() => Promise.resolve(agentCatalogEntries)),
    getAgentCatalogEntry: mock((agentId) => Promise.resolve(agentCatalogEntries.find((agent) => agent.id === agentId) ?? null)),
    requiresStrictModelDiscovery: mock((agentId) => agentId === 'pi'),
  },
  apiProviders: {
    getCatalog: mock(() => []),
  },
};

const responseCache = new ModelCatalogResponseCache();
const modelsRoutes = createModelsRoutes({ modelCatalog, responseCache });
const handler = modelsRoutes['/api/v1/models'].GET;

describe('GET /api/v1/models', () => {
  beforeEach(() => {
    responseCache.clear();
    modelCatalog.agents.getAgentCatalogEntries.mockClear();
    modelCatalog.agents.getAgentCatalogEntry.mockClear();
    modelCatalog.agents.requiresStrictModelDiscovery.mockClear();
    modelCatalog.apiProviders.getCatalog.mockClear();
  });

  it('returns only the agent/API provider catalog', async () => {
    const response = await handler();
    const body = await response.json();

    expect(response.headers.get('etag')).toMatch(/^W\/"model-catalog:/);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(Object.keys(body)).toEqual(['catalog']);
    expect(Array.isArray(body.catalog.agents)).toBe(true);
    expect(Array.isArray(body.catalog.apiProviders)).toBe(true);
  });

  it('returns 304 when the model catalog etag matches', async () => {
    const url = new URL('http://localhost/api/v1/models');
    const first = await handler(new Request(url), url);
    const etag = first.headers.get('etag');

    const second = await handler(
      new Request(url, {
        headers: { 'If-None-Match': etag },
      }),
      url,
    );

    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"model-catalog:/);
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('private, no-cache');
    expect(await second.text()).toBe('');
  });

  it('reuses a fresh aggregate catalog snapshot across full catalog requests', async () => {
    const url = new URL('http://localhost/api/v1/models');

    await handler(new Request(url), url);
    await handler(new Request(url), url);

    expect(modelCatalog.agents.getAgentCatalogEntries).toHaveBeenCalledTimes(1);
  });

  it('changes the etag when model catalog content changes', async () => {
    modelCatalog.agents.getAgentCatalogEntries
      .mockResolvedValueOnce([
        { ...agentCatalogEntries[0], models: [{ value: 'opus', label: 'Opus' }] },
      ])
      .mockResolvedValueOnce([
        { ...agentCatalogEntries[0], models: [{ value: 'sonnet', label: 'Sonnet' }] },
      ]);

    const url = new URL('http://localhost/api/v1/models');
    const first = await handler(new Request(url), url);
    responseCache.clear();
    const second = await handler(new Request(url), url);

    expect(first.headers.get('etag')).not.toBe(second.headers.get('etag'));
  });

  it('keeps the etag stable when catalog ordering changes', async () => {
    modelCatalog.agents.getAgentCatalogEntries
      .mockResolvedValueOnce([
        {
          ...agentCatalogEntries[0],
          models: [
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
          ],
        },
        {
          ...agentCatalogEntries[1],
          models: [
            { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
            { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          ...agentCatalogEntries[1],
          models: [
            { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
            { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
          ],
        },
        {
          ...agentCatalogEntries[0],
          models: [
            { value: 'opus', label: 'Opus' },
            { value: 'sonnet', label: 'Sonnet' },
          ],
        },
      ]);

    const url = new URL('http://localhost/api/v1/models');
    const first = await handler(new Request(url), url);
    responseCache.clear();
    const second = await handler(new Request(url), url);

    expect(first.headers.get('etag')).toBe(second.headers.get('etag'));
  });

  it('returns catalog.agents with capability metadata', async () => {
    const response = await handler();
    const body = await response.json();

    expect(body.catalog).toBeDefined();
    expect(Array.isArray(body.catalog.agents)).toBe(true);
    expect(body.catalog.agents.length).toBe(9);

    const claude = body.catalog.agents.find((p) => p.id === 'claude');
    expect(claude.supportsFork).toBe(true);
    expect(claude.supportsForkAtMessage).toBe(true);
    expect(claude.supportsForkWhileRunning).toBe(true);
    expect(claude.supportsUpdateProjectPath).toBe(true);
    expect(claude.supportsImages).toBe(true);
    expect(Array.isArray(claude.models)).toBe(true);
    expect(claude.defaultModel).toBe('opus');

    const codex = body.catalog.agents.find((p) => p.id === 'codex');
    expect(codex.supportsFork).toBe(true);
    expect(codex.supportsForkAtMessage).toBe(true);
    expect(codex.supportsForkWhileRunning).toBe(true);
    expect(codex.supportsUpdateProjectPath).toBe(true);
    expect(codex.supportsImages).toBe(true);
    expect(codex.defaultModel).toBe('gpt-5.5');
    expect(codex.models[0]).toEqual({ value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true });
    const codexModelValues = codex.models.map((model) => model.value);
    expect(codexModelValues).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
    ]);
    expect(codex.models.find((model) => model.value === 'gpt-5.5')).toMatchObject({ supportsImages: true });
    expect(codex.models.find((model) => model.value === 'gpt-5.6-sol')).toMatchObject({ supportsImages: true });
    expect(codex.models.find((model) => model.value === 'gpt-5.6-terra')).toMatchObject({ supportsImages: true });
    expect(codex.models.find((model) => model.value === 'gpt-5.6-luna')).toMatchObject({ supportsImages: true });
    expect(codex.models.find((model) => model.value === 'gpt-5.4')).toMatchObject({ supportsImages: true });
    expect(codex.models.find((model) => model.value === 'gpt-5.3-codex')).toMatchObject({ supportsImages: true });
    expect(codex.models.find((model) => model.value === 'gpt-5.3-codex-spark')).toMatchObject({ supportsImages: false });
    expect(codexModelValues).not.toContain('gpt-5.2');
    expect(codexModelValues).not.toContain('gpt-5.2-codex');
    expect(codexModelValues).not.toContain('gpt-5.1-codex-max');
    expect(codexModelValues).not.toContain('gpt-5.1-codex-mini');

    const opencode = body.catalog.agents.find((p) => p.id === 'opencode');
    expect(opencode.supportsFork).toBe(true);
    expect(opencode.supportsForkAtMessage).toBe(false);
    expect(opencode.supportsForkWhileRunning).toBe(false);
    expect(opencode.supportsUpdateProjectPath).toBe(false);
    expect(opencode.supportsImages).toBe(false);

    const factory = body.catalog.agents.find((p) => p.id === 'factory');
    expect(factory.supportsFork).toBe(false);
    expect(factory.supportsForkAtMessage).toBe(false);
    expect(factory.supportsUpdateProjectPath).toBe(false);
    expect(factory.supportsImages).toBe(false);
    expect(Array.isArray(factory.models)).toBe(true);
    expect(factory.defaultModel).toBe('claude-opus-4-6');
    const factoryModelValues = factory.models.map((model) => model.value);
    expect(factoryModelValues).not.toContain('gpt-5.2');
    expect(factoryModelValues).not.toContain('gpt-5.2-codex');
    expect(factoryModelValues).not.toContain('gpt-5.1-codex-max');

    const pi = body.catalog.agents.find((p) => p.id === 'pi');
    expect(pi.label).toBe('Pi');
    expect(pi.supportsFork).toBe(true);
    expect(pi.supportsForkAtMessage).toBe(false);
    expect(pi.supportsUpdateProjectPath).toBe(true);
    expect(pi.supportsImages).toBe(false);
    expect(pi.acceptsApiProviderEndpoints).toBe(false);
    expect(pi.supportedProtocols).toEqual([]);
    expect(pi.defaultModel).toBe('github-copilot/gpt-5.4');
    expect(pi.models).toContainEqual({ value: 'github-copilot/gpt-5.4', label: 'github-copilot: gpt-5.4', supportsImages: true });

    const directOpenAi = body.catalog.agents.find((p) => p.id === 'direct-openai-compatible');
    expect(directOpenAi.label).toBe('Direct (Chat Completions)');
    expect(directOpenAi.supportsFork).toBe(true);
    expect(directOpenAi.supportsForkAtMessage).toBe(true);
    expect(directOpenAi.supportsForkWhileRunning).toBe(false);
    expect(directOpenAi.supportsUpdateProjectPath).toBe(true);
    expect(directOpenAi.supportsImages).toBe(true);
    expect(directOpenAi.supportedProtocols).toEqual(['openai-compatible']);

    const directOpenAiResponses = body.catalog.agents.find((p) => p.id === 'direct-openai-responses-compatible');
    expect(directOpenAiResponses.label).toBe('Direct (Responses)');
    expect(directOpenAiResponses.supportsFork).toBe(true);
    expect(directOpenAiResponses.supportsForkAtMessage).toBe(true);
    expect(directOpenAiResponses.supportsForkWhileRunning).toBe(false);
    expect(directOpenAiResponses.supportsUpdateProjectPath).toBe(true);
    expect(directOpenAiResponses.supportsImages).toBe(true);
    expect(directOpenAiResponses.supportedProtocols).toEqual(['openai-compatible']);

    const directAnthropic = body.catalog.agents.find((p) => p.id === 'direct-anthropic-compatible');
    expect(directAnthropic.label).toBe('Direct (Anthropic)');
    expect(directAnthropic.supportsFork).toBe(true);
    expect(directAnthropic.supportsForkAtMessage).toBe(true);
    expect(directAnthropic.supportsForkWhileRunning).toBe(false);
    expect(directAnthropic.supportsUpdateProjectPath).toBe(true);
    expect(directAnthropic.supportsImages).toBe(true);
    expect(directAnthropic.supportedProtocols).toEqual(['anthropic-messages']);

    expect(body.catalog.agents.find((p) => p.id === 'zai')).toBeUndefined();
  });

  it('filters the catalog when agent param is given', async () => {
    const url = new URL('http://localhost/api/v1/models?agent=claude');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(body.catalog.agents.length).toBe(1);
    expect(body.catalog.agents[0].id).toBe('claude');
  });

  it('uses strict Pi discovery for the Pi agent filter', async () => {
    modelCatalog.agents.getAgentCatalogEntry.mockResolvedValueOnce({
      ...agentCatalogEntries.find((agent) => agent.id === 'pi'),
      defaultModel: 'openrouter/openai/gpt-5.4',
      models: [{ value: 'openrouter/openai/gpt-5.4', label: 'openrouter: gpt-5.4', supportsImages: true }],
    });
    const url = new URL('http://localhost/api/v1/models?agent=pi');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(modelCatalog.agents.getAgentCatalogEntry).toHaveBeenCalledWith('pi', { strict: true });
    expect(body.catalog.agents).toHaveLength(1);
    expect(body.catalog.agents[0].id).toBe('pi');
    expect(body.catalog.agents[0].models).toEqual([
      { value: 'openrouter/openai/gpt-5.4', label: 'openrouter: gpt-5.4', supportsImages: true },
    ]);
  });

  it('returns a 503 when strict model discovery has no stale models', async () => {
    const error = Object.assign(new Error('auth storage: auth.json is locked'), {
      code: 'PI_MODEL_DISCOVERY_UNAVAILABLE',
      staleModels: [],
    });
    modelCatalog.agents.getAgentCatalogEntry.mockRejectedValueOnce(error);
    const url = new URL('http://localhost/api/v1/models?agent=pi');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: 'Model discovery unavailable',
      reason: 'auth storage: auth.json is locked',
    });
  });

  it('returns stale Pi models in the 503 body when available', async () => {
    const staleModels = [
      { value: 'openrouter/openai/gpt-5.4', label: 'openrouter: gpt-5.4', supportsImages: true },
    ];
    const error = Object.assign(new Error('auth storage: auth.json is locked'), {
      code: 'PI_MODEL_DISCOVERY_UNAVAILABLE',
      staleModels,
    });
    modelCatalog.agents.getAgentCatalogEntry.mockRejectedValueOnce(error);
    const url = new URL('http://localhost/api/v1/models?agent=pi');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe('Model discovery unavailable');
    expect(body.catalog.agents).toHaveLength(1);
    expect(body.catalog.agents[0].id).toBe('pi');
    expect(body.catalog.agents[0].models).toEqual(staleModels);
  });
});
