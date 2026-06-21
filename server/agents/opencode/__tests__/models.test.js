import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let originalWarn;

beforeEach(() => {
  originalWarn = console.warn;
  console.warn = mock(() => {});
});

afterEach(() => {
  console.warn = originalWarn;
});

function never() {
  return new Promise(() => {});
}

function configuredProvidersResult() {
  return {
    data: {
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'env',
          models: {
            'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
          },
        },
        {
          id: 'local-router',
          name: 'Local Router',
          source: 'config',
          models: {
            local: { id: 'local', name: 'Local Model' },
          },
        },
      ],
    },
  };
}

async function importProvider() {
  const { OpenCodeRuntime } = await import('../opencode.js');
  return OpenCodeRuntime;
}

describe('OpenCodeRuntime model discovery', () => {
  it('starts OpenCode and lists models from configured providers', async () => {
    const configProviders = mock(() => Promise.resolve(configuredProvidersResult()));
    const providerList = mock(() => Promise.resolve({ data: { all: [], connected: [] } }));
    const createInstance = mock(() => Promise.resolve({
      client: {
        config: { providers: configProviders },
        permission: { reply: mock(() => Promise.resolve({})) },
        provider: { list: providerList },
      },
      server: { close: mock(() => {}) },
    }));

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({ createInstance });

    expect(await provider.getModels()).toEqual([
      { value: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5' },
      { value: 'local-router/local', label: 'Local Router: Local Model' },
    ]);
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(configProviders).toHaveBeenCalledTimes(1);
    expect(providerList).not.toHaveBeenCalled();
  });

  it('falls back to provider.list when the SDK has no config.providers method', async () => {
    const providerList = mock(() => Promise.resolve({
      data: {
        connected: ['openai'],
        all: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            source: 'env',
            models: {
              'claude-sonnet': { id: 'claude-sonnet', name: 'Claude Sonnet' },
            },
          },
          {
            id: 'openai',
            name: 'OpenAI',
            source: 'env',
            models: {
              'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5' },
            },
          },
        ],
      },
    }));
    const createInstance = mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        provider: { list: providerList },
      },
      server: { close: mock(() => {}) },
    }));

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({ createInstance });

    expect(await provider.getModels()).toEqual([
      { value: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5' },
    ]);
    expect(providerList).toHaveBeenCalledTimes(1);
  });

  it('deduplicates hanging model discovery and suppresses retries during cooldown', async () => {
    const close = mock(() => {});
    const configProviders = mock(() => never());
    const createInstance = mock(() => Promise.resolve({
      client: {
        config: { providers: configProviders },
        permission: { reply: mock(() => Promise.resolve({})) },
      },
      server: { close },
    }));

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({
      createInstance,
      modelDiscoveryTimeoutMs: 5,
      unavailableRetryMs: 1_000,
    });

    const [first, second] = await Promise.all([
      provider.getModels(),
      provider.getModels(),
    ]);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(configProviders).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(provider.isTemporarilyUnavailable()).toBe(true);

    expect(await provider.getModels()).toEqual([]);
    expect(createInstance).toHaveBeenCalledTimes(1);
    expect(configProviders).toHaveBeenCalledTimes(1);
  });

  it('retries model discovery after the cooldown expires', async () => {
    let now = 1_000;
    let shouldHang = true;
    const configProviders = mock(() => shouldHang ? never() : Promise.resolve(configuredProvidersResult()));
    const createInstance = mock(() => Promise.resolve({
      client: {
        config: { providers: configProviders },
        permission: { reply: mock(() => Promise.resolve({})) },
      },
      server: { close: mock(() => {}) },
    }));

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({
      createInstance,
      modelDiscoveryTimeoutMs: 5,
      unavailableRetryMs: 1_000,
      now: () => now,
    });

    expect(await provider.getModels()).toEqual([]);
    expect(createInstance).toHaveBeenCalledTimes(1);

    shouldHang = false;
    now += 1_001;

    expect(await provider.getModels()).toEqual([
      { value: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5' },
      { value: 'local-router/local', label: 'Local Router: Local Model' },
    ]);
    expect(createInstance).toHaveBeenCalledTimes(2);
    expect(configProviders).toHaveBeenCalledTimes(2);
    expect(provider.isTemporarilyUnavailable()).toBe(false);
  });

  it('returns cached models when a stale refresh times out', async () => {
    let now = 1_000;
    let shouldHang = false;
    const configProviders = mock(() => shouldHang ? never() : Promise.resolve(configuredProvidersResult()));
    const createInstance = mock(() => Promise.resolve({
      client: {
        config: { providers: configProviders },
        permission: { reply: mock(() => Promise.resolve({})) },
      },
      server: { close: mock(() => {}) },
    }));

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({
      createInstance,
      modelDiscoveryTimeoutMs: 5,
      unavailableRetryMs: 1_000,
      modelCacheTtlMs: 10,
      now: () => now,
    });

    const expected = [
      { value: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5' },
      { value: 'local-router/local', label: 'Local Router: Local Model' },
    ];

    expect(await provider.getModels()).toEqual(expected);

    shouldHang = true;
    now += 11;

    expect(await provider.getModels()).toEqual(expected);
    expect(provider.isTemporarilyUnavailable()).toBe(true);

    expect(await provider.getModels()).toEqual(expected);
    expect(configProviders).toHaveBeenCalledTimes(2);
  });

  it('marks startup failures unavailable and skips immediate retries', async () => {
    const createInstance = mock(() => never());

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({
      createInstance,
      startupTimeoutMs: 5,
      unavailableRetryMs: 1_000,
    });

    await expect(provider.getClient()).rejects.toThrow('OpenCode startup timed out after 5ms');
    expect(provider.isTemporarilyUnavailable()).toBe(true);
    expect(createInstance).toHaveBeenCalledTimes(1);

    await expect(provider.getClient()).rejects.toThrow('OpenCode is temporarily unavailable');
    expect(createInstance).toHaveBeenCalledTimes(1);
  });

  it('closes the SDK v2 server during shutdown', async () => {
    const close = mock(() => {});
    const createInstance = mock(() => Promise.resolve({
      client: {
        config: { providers: mock(() => Promise.resolve(configuredProvidersResult())) },
        permission: { reply: mock(() => Promise.resolve({})) },
      },
      server: { close },
    }));

    const OpenCodeRuntime = await importProvider();
    const provider = new OpenCodeRuntime({ createInstance });

    await provider.getClient();
    provider.shutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(provider.getClientIfInitialized()).toBeNull();
  });
});
