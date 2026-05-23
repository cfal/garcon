import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiProviderStore } from '../store.ts';

const createdDirs = [];
const openRouterKeyEnv = ['OPENROUTER', 'API', 'KEY'].join('_');
const zaiKeyEnv = ['ZAI', 'API', 'KEY'].join('_');

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-api-providers-'));
  createdDirs.push(dir);
  return new ApiProviderStore(path.join(dir, 'api-providers.json'));
}

describe('ApiProviderStore', () => {
  afterEach(async () => {
    delete process.env[openRouterKeyEnv];
    delete process.env[zaiKeyEnv];
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('starts with no API providers and ignores environment API keys', async () => {
    process.env[openRouterKeyEnv] = 'sk-openrouter';
    process.env[zaiKeyEnv] = 'sk-zai';
    const store = await tempStore();
    await store.init();

    expect(store.redactedList()).toEqual([]);
  });

  it('creates user-managed providers from templates without exposing API keys', async () => {
    const store = await tempStore();
    await store.init();

    const provider = await store.createApiProvider({
      templateId: 'openrouter',
      label: 'OpenRouter',
      protocol: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-secret',
      capabilities: { chatCompletions: true, responses: true },
      defaultModel: 'openai/gpt-5.4',
      models: [{ value: 'openai/gpt-5.4', label: 'GPT-5.4' }],
      supportsImages: true,
      modelDiscovery: 'openrouter-models',
    });

    expect(provider.templateId).toBe('openrouter');
    expect(provider.endpoints[0].capabilities).toEqual({
      chatCompletions: true,
      responses: true,
    });
    expect(provider.endpoints[0].headers).toEqual({
      'HTTP-Referer': 'https://github.com/cfal/garcon',
      'X-OpenRouter-Title': 'Garcon',
    });

    const [redacted] = store.redactedList();
    expect(redacted.endpoints[0].hasApiKey).toBe(true);
    expect('apiKey' in redacted.endpoints[0]).toBe(false);
    expect('headers' in redacted.endpoints[0]).toBe(false);
  });

  it('allows blank API keys for local Ollama templates', async () => {
    const store = await tempStore();
    await store.init();

    const provider = await store.createApiProvider({
      templateId: 'ollama',
      label: 'Ollama',
      protocol: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      capabilities: { chatCompletions: true, responses: false },
      defaultModel: 'llama3',
      models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
      supportsImages: false,
      modelDiscovery: 'ollama-tags',
    });

    expect(provider.endpoints[0].apiKey).toBe('');
    expect(store.redactedList()[0].endpoints[0].hasApiKey).toBe(false);
  });

  it('stores Anthropic-compatible endpoints without OpenAI capabilities', async () => {
    const store = await tempStore();
    await store.init();

    const provider = await store.createApiProvider({
      templateId: 'custom',
      label: 'Acme Anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.acme.test',
      apiKey: 'sk-acme',
      defaultModel: 'acme-sonnet',
      models: [{ value: 'acme-sonnet', label: 'Acme Sonnet' }],
      supportsImages: true,
      modelDiscovery: 'anthropic-models',
    });

    expect(provider.endpoints[0].capabilities).toBeUndefined();
  });

  it('keeps existing API key when an edit sends a blank key', async () => {
    const store = await tempStore();
    await store.init();
    const provider = await store.createApiProvider({
      templateId: 'custom',
      label: 'Example',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-original',
      capabilities: { chatCompletions: true, responses: true },
      defaultModel: 'example',
      models: [{ value: 'example', label: 'Example' }],
      supportsImages: false,
      modelDiscovery: 'openai-models',
    });

    const updated = await store.updateApiProvider(provider.id, {
      endpoint: {
        id: provider.endpoints[0].id,
        apiKey: '',
      },
    });

    expect(updated.endpoints[0].apiKey).toBe('sk-original');
  });

  it('clears API key only when clearApiKey is explicit', async () => {
    const store = await tempStore();
    await store.init();
    const provider = await store.createApiProvider({
      templateId: 'custom',
      label: 'Example',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-original',
      capabilities: { chatCompletions: true, responses: true },
      defaultModel: 'example',
      models: [{ value: 'example', label: 'Example' }],
      supportsImages: false,
      modelDiscovery: 'openai-models',
    });

    const updated = await store.updateApiProvider(provider.id, {
      endpoint: {
        id: provider.endpoints[0].id,
        clearApiKey: true,
      },
    });

    expect(updated.endpoints[0].apiKey).toBe('');
    expect(updated.endpoints[0].apiKeyLabel).toBe('');
  });

  it('rejects OpenAI-compatible endpoints with no supported API surface', async () => {
    const store = await tempStore();
    await store.init();

    await expect(store.createApiProvider({
      templateId: 'custom',
      label: 'Example',
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.test/v1',
      capabilities: { chatCompletions: false, responses: false },
      defaultModel: 'example-model',
      models: [],
      supportsImages: false,
      modelDiscovery: 'openai-models',
    })).rejects.toThrow('OpenAI-compatible endpoints must support Chat Completions or Responses.');
  });
});
