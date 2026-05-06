import { describe, it, expect, mock } from 'bun:test';
import createModelsRoutes from '../models.js';

const providers = {
  getModels: mock(() => Promise.resolve([])),
  getHarnessCatalog: mock(() => Promise.resolve({
    harnesses: [
      { id: 'claude', label: 'Claude', kind: 'harness', supportsFork: true, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['anthropic-messages'], defaultModel: 'opus', models: [{ value: 'opus', label: 'Opus', supportsImages: true }] },
      { id: 'codex', label: 'Codex', kind: 'harness', supportsFork: true, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'], defaultModel: 'gpt-5.5', models: [{ value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true }, { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', supportsImages: true }] },
      { id: 'opencode', label: 'OpenCode', kind: 'harness', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], defaultModel: '', models: [] },
      { id: 'amp', label: 'Amp', kind: 'harness', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], defaultModel: 'default', models: [{ value: 'default', label: 'Default' }] },
      { id: 'factory', label: 'Factory', kind: 'harness', supportsFork: false, supportsImages: false, acceptsApiProviderEndpoints: false, supportedProtocols: [], defaultModel: 'claude-opus-4-6', models: [{ value: 'claude-opus-4-6', label: 'Claude Opus 4-6' }] },
      { id: 'direct-anthropic-compatible', label: 'Direct (Anthropic)', kind: 'harness', supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['anthropic-messages'], defaultModel: '', models: [] },
      { id: 'direct-openai-compatible', label: 'Direct (Chat Completions)', kind: 'harness', supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'], defaultModel: '', models: [] },
      { id: 'direct-openai-responses-compatible', label: 'Direct (Responses)', kind: 'harness', supportsFork: false, supportsImages: true, acceptsApiProviderEndpoints: true, supportedProtocols: ['openai-compatible'], defaultModel: '', models: [] },
    ],
    apiProviders: [],
  })),
};

const modelsRoutes = createModelsRoutes(providers);
const handler = modelsRoutes['/api/v1/models'].GET;

describe('GET /api/v1/models', () => {
  it('returns only the harness/API provider catalog', async () => {
    const response = await handler();
    const body = await response.json();

    expect(Object.keys(body)).toEqual(['catalog']);
    expect(Array.isArray(body.catalog.harnesses)).toBe(true);
    expect(Array.isArray(body.catalog.apiProviders)).toBe(true);
  });

  it('returns catalog.harnesses with capability metadata', async () => {
    const response = await handler();
    const body = await response.json();

    expect(body.catalog).toBeDefined();
    expect(Array.isArray(body.catalog.harnesses)).toBe(true);
    expect(body.catalog.harnesses.length).toBe(8);

    const claude = body.catalog.harnesses.find((p) => p.id === 'claude');
    expect(claude.supportsFork).toBe(true);
    expect(claude.supportsImages).toBe(true);
    expect(Array.isArray(claude.models)).toBe(true);
    expect(claude.defaultModel).toBe('opus');

    const codex = body.catalog.harnesses.find((p) => p.id === 'codex');
    expect(codex.supportsFork).toBe(true);
    expect(codex.supportsImages).toBe(true);
    expect(codex.defaultModel).toBe('gpt-5.5');
    expect(codex.models[0]).toEqual({ value: 'gpt-5.5', label: 'GPT-5.5', supportsImages: true });
    const codexModelValues = codex.models.map((model) => model.value);
    expect(codexModelValues).toContain('gpt-5.3-codex-spark');
    expect(codexModelValues).not.toContain('gpt-5.2');
    expect(codexModelValues).not.toContain('gpt-5.2-codex');
    expect(codexModelValues).not.toContain('gpt-5.1-codex-max');
    expect(codexModelValues).not.toContain('gpt-5.1-codex-mini');

    const opencode = body.catalog.harnesses.find((p) => p.id === 'opencode');
    expect(opencode.supportsFork).toBe(false);
    expect(opencode.supportsImages).toBe(false);

    const factory = body.catalog.harnesses.find((p) => p.id === 'factory');
    expect(factory.supportsFork).toBe(false);
    expect(factory.supportsImages).toBe(false);
    expect(Array.isArray(factory.models)).toBe(true);
    expect(factory.defaultModel).toBe('claude-opus-4-6');
    const factoryModelValues = factory.models.map((model) => model.value);
    expect(factoryModelValues).not.toContain('gpt-5.2');
    expect(factoryModelValues).not.toContain('gpt-5.2-codex');
    expect(factoryModelValues).not.toContain('gpt-5.1-codex-max');

    const directOpenAi = body.catalog.harnesses.find((p) => p.id === 'direct-openai-compatible');
    expect(directOpenAi.label).toBe('Direct (Chat Completions)');
    expect(directOpenAi.supportsFork).toBe(false);
    expect(directOpenAi.supportsImages).toBe(true);
    expect(directOpenAi.supportedProtocols).toEqual(['openai-compatible']);

    const directOpenAiResponses = body.catalog.harnesses.find((p) => p.id === 'direct-openai-responses-compatible');
    expect(directOpenAiResponses.label).toBe('Direct (Responses)');
    expect(directOpenAiResponses.supportsFork).toBe(false);
    expect(directOpenAiResponses.supportsImages).toBe(true);
    expect(directOpenAiResponses.supportedProtocols).toEqual(['openai-compatible']);

    const directAnthropic = body.catalog.harnesses.find((p) => p.id === 'direct-anthropic-compatible');
    expect(directAnthropic.label).toBe('Direct (Anthropic)');
    expect(directAnthropic.supportsFork).toBe(false);
    expect(directAnthropic.supportsImages).toBe(true);
    expect(directAnthropic.supportedProtocols).toEqual(['anthropic-messages']);

    expect(body.catalog.harnesses.find((p) => p.id === 'zai')).toBeUndefined();
  });

  it('filters the catalog when harness param is given', async () => {
    const url = new URL('http://localhost/api/v1/models?harness=claude');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(body.catalog.harnesses.length).toBe(1);
    expect(body.catalog.harnesses[0].id).toBe('claude');
  });
});
