import { describe, expect, it, mock } from 'bun:test';

describe('OpenCodeProvider model discovery', () => {
  it('starts OpenCode and lists models for providers OpenCode reports as connected', async () => {
    const providerList = mock(() => Promise.resolve({
      data: {
        connected: ['openai', 'local-router', 'custom-provider'],
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
            id: 'public-catalog-provider',
            name: 'Public Catalog Provider',
            source: 'custom',
            models: {
              catalog: { id: 'catalog', name: 'Catalog Model' },
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
          {
            id: 'local-router',
            name: 'Local Router',
            source: 'config',
            models: {
              local: { id: 'local', name: 'Local Model' },
            },
          },
          {
            id: 'custom-provider',
            name: 'Custom Provider',
            source: 'custom',
            models: {
              custom: { id: 'custom', name: 'Custom Model' },
            },
          },
        ],
      },
    }));

    const createOpencode = mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        provider: { list: providerList },
      },
      close: mock(() => {}),
    }));

    mock.module('@opencode-ai/sdk/v2', () => ({ createOpencode }));

    const { OpenCodeProvider } = await import('../opencode.js');
    const provider = new OpenCodeProvider();

    expect(await provider.getModels()).toEqual([
      { value: 'openai/gpt-5.5', label: 'OpenAI: GPT-5.5' },
      { value: 'local-router/local', label: 'Local Router: Local Model' },
      { value: 'custom-provider/custom', label: 'Custom Provider: Custom Model' },
    ]);
    expect(createOpencode).toHaveBeenCalled();
    expect(providerList).toHaveBeenCalled();
  });
});
