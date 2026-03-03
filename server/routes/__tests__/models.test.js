import { describe, it, expect, mock } from 'bun:test';
import createModelsRoutes from '../models.js';

const providers = {
  getModels: mock(() => Promise.resolve([])),
};

const modelsRoutes = createModelsRoutes(providers);
const handler = modelsRoutes['/api/v1/models'].GET;

describe('GET /api/v1/models', () => {
  it('returns top-level provider keys for backward compatibility', async () => {
    const response = await handler();
    const body = await response.json();

    expect(body.claude).toBeDefined();
    expect(body.codex).toBeDefined();
    expect(body.opencode).toBeDefined();
    expect(Array.isArray(body.claude)).toBe(true);
  });

  it('returns catalog.providers with capability metadata', async () => {
    const response = await handler();
    const body = await response.json();

    expect(body.catalog).toBeDefined();
    expect(Array.isArray(body.catalog.providers)).toBe(true);
    expect(body.catalog.providers.length).toBe(3);

    const claude = body.catalog.providers.find((p) => p.id === 'claude');
    expect(claude.supportsFork).toBe(true);
    expect(claude.supportsImages).toBe(true);
    expect(Array.isArray(claude.models)).toBe(true);
    expect(claude.defaultModel).toBe('opus');

    const codex = body.catalog.providers.find((p) => p.id === 'codex');
    expect(codex.supportsFork).toBe(true);
    expect(codex.supportsImages).toBe(false);

    const opencode = body.catalog.providers.find((p) => p.id === 'opencode');
    expect(opencode.supportsFork).toBe(false);
    expect(opencode.supportsImages).toBe(false);
  });

  it('filters both top-level and catalog when provider param is given', async () => {
    const url = new URL('http://localhost/api/v1/models?provider=claude');
    const response = await handler(new Request(url), url);
    const body = await response.json();

    expect(body.claude).toBeDefined();
    expect(body.codex).toBeUndefined();
    expect(body.catalog.providers.length).toBe(1);
    expect(body.catalog.providers[0].id).toBe('claude');
  });
});
