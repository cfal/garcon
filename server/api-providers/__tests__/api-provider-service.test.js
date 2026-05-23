import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiProviderService } from '../service.ts';
import { ApiProviderStore } from '../store.ts';

const createdDirs = [];
let originalFetch = globalThis.fetch;

async function tempService(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-api-provider-service-'));
  createdDirs.push(dir);
  const store = new ApiProviderStore(path.join(dir, 'api-providers.json'));
  await store.init();
  const service = new ApiProviderService({
    store,
    isApiProviderReferenced: options.isApiProviderReferenced ?? (() => false),
  });
  return { service, store };
}

function openAiInput(overrides = {}) {
  const { endpoint: endpointOverrides, ...rootOverrides } = overrides;
  return {
    templateId: 'custom',
    label: 'Acme OpenAI',
    endpoint: {
      protocol: 'openai-compatible',
      baseUrl: 'api.acme.test/v1',
      apiKey: 'sk-acme-secret',
      capabilities: { chatCompletions: true, responses: true },
      defaultModel: 'acme/default',
      models: [{ value: 'acme/default', label: 'Acme Default' }],
      supportsImages: true,
      modelDiscovery: 'openai-models',
      ...(endpointOverrides ?? {}),
    },
    ...rootOverrides,
  };
}

describe('ApiProviderService', () => {
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('creates API providers and returns a redacted catalog entry', async () => {
    const { service, store } = await tempService();

    const created = await service.create(openAiInput());

    expect(created.label).toBe('Acme OpenAI');
    expect(created.endpoints[0]).toMatchObject({
      baseUrl: 'https://api.acme.test/v1',
      hasApiKey: true,
      apiKeyLabel: 'sk-a...cret',
    });
    expect('apiKey' in created.endpoints[0]).toBe(false);
    expect(store.list()[0].endpoints[0].apiKey).toBe('sk-acme-secret');
  });

  it('blocks deletion through the injected reference check', async () => {
    const { service } = await tempService({ isApiProviderReferenced: () => true });
    const created = await service.create(openAiInput());

    await expect(service.delete(created.id)).rejects.toThrow('API provider is used by existing chats');
  });

  it('validates API provider input before persistence', async () => {
    const { service, store } = await tempService();

    await expect(service.create(openAiInput({
      endpoint: {
        capabilities: { chatCompletions: false, responses: false },
      },
    }))).rejects.toThrow('OpenAI-compatible endpoints must support Chat Completions or Responses.');

    expect(store.list()).toEqual([]);
  });

  it('uses stored endpoint API keys for model discovery requests', async () => {
    const { service } = await tempService();
    const created = await service.create(openAiInput());
    const endpoint = created.endpoints[0];
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
      data: [{ id: 'acme/model', name: 'Acme Model' }],
    }), { status: 200 })));
    globalThis.fetch = fetchMock;

    const discovered = await service.discoverModels({
      protocol: 'openai-compatible',
      baseUrl: endpoint.baseUrl,
      endpointId: endpoint.id,
      modelDiscovery: 'openai-models',
    });

    expect(discovered).toEqual({
      success: true,
      models: [{ value: 'acme/model', label: 'Acme Model' }],
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.acme.test/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-acme-secret' },
    }));
  });
});
