import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiProviderStore } from '../api-provider-store.ts';

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
      protocol: 'openai-chat-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-secret',
      exposeTo: ['codex', 'direct-openai-compatible'],
      defaultModel: 'openai/gpt-5.4',
      models: [{ value: 'openai/gpt-5.4', label: 'GPT-5.4' }],
      supportsImages: true,
      modelDiscovery: 'openrouter-models',
    });

    expect(provider.templateId).toBe('openrouter');
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
      protocol: 'openai-chat-completions',
      baseUrl: 'http://localhost:11434/v1',
      exposeTo: ['direct-openai-compatible'],
      defaultModel: 'llama3',
      models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
      supportsImages: false,
      modelDiscovery: 'ollama-tags',
    });

    expect(provider.endpoints[0].apiKey).toBe('');
    expect(store.redactedList()[0].endpoints[0].hasApiKey).toBe(false);
  });

  it('keeps existing API key when an edit sends a blank key', async () => {
    const store = await tempStore();
    await store.init();
    const provider = await store.createApiProvider({
      templateId: 'custom',
      label: 'Example',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-original',
      exposeTo: ['codex'],
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
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'sk-original',
      exposeTo: ['codex'],
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

  it('rejects API provider endpoints exposed to incompatible harnesses', async () => {
    const store = await tempStore();
    await store.init();

    await expect(store.createApiProvider({
      templateId: 'custom',
      label: 'Example',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.example.test/v1',
      exposeTo: ['claude'],
      defaultModel: 'example-model',
      models: [],
      supportsImages: false,
      modelDiscovery: 'openai-models',
    })).rejects.toThrow('OpenAI-compatible harness');

    await expect(store.createApiProvider({
      templateId: 'custom',
      label: 'Example',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.example.test/anthropic',
      exposeTo: ['codex'],
      defaultModel: 'example-model',
      models: [],
      supportsImages: false,
      modelDiscovery: 'none',
    })).rejects.toThrow('Anthropic-compatible harness');
  });
});
