import { describe, expect, it } from 'bun:test';
import { ApiProviderEndpointResolver, ModelSelectionError } from '../api-provider-endpoint-resolver.ts';

function makeResolver() {
  return new ApiProviderEndpointResolver(() => [
    {
      id: 'acme',
      label: 'Acme',
      templateId: 'custom',
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
      endpoints: [
        {
          id: 'acme_openai',
          protocol: 'openai-compatible',
          baseUrl: 'https://api.acme.test/v1',
          apiKey: 'secret',
          capabilities: { chatCompletions: true, responses: true },
          defaultModel: 'acme-code',
          models: [{ value: 'acme-code', label: 'Acme Code', supportsImages: false }],
          supportsImages: false,
          modelDiscovery: 'openai-models',
          headers: {
            'HTTP-Referer': 'https://github.com/cfal/garcon',
            'X-OpenRouter-Title': 'Garcon',
          },
        },
        {
          id: 'acme_openai_blank',
          protocol: 'openai-compatible',
          baseUrl: 'http://localhost:11434/v1',
          apiKey: '',
          capabilities: { chatCompletions: false, responses: true },
          defaultModel: 'llama3',
          models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
          supportsImages: false,
          modelDiscovery: 'ollama-tags',
        },
        {
          id: 'acme_anthropic',
          protocol: 'anthropic-messages',
          baseUrl: 'https://api.acme.test/anthropic',
          apiKey: 'secret',
          defaultModel: 'acme-claude',
          models: [{ value: 'acme-claude', label: 'Acme Claude', supportsImages: true }],
          supportsImages: true,
          modelDiscovery: 'none',
        },
        {
          id: 'acme_anthropic_blank',
          protocol: 'anthropic-messages',
          baseUrl: 'http://localhost:11434',
          apiKey: '',
          defaultModel: 'llama3',
          models: [{ value: 'llama3', label: 'llama3 (local)', isLocal: true }],
          supportsImages: false,
          modelDiscovery: 'ollama-tags',
        },
      ],
    },
  ]);
}

describe('ApiProviderEndpointResolver', () => {
  it('uses endpoint-scoped option values while resolving to raw model IDs', () => {
    const resolver = makeResolver();
    const [option] = resolver.getModelOptions('direct-openai-compatible');

    expect(option).toMatchObject({
      value: 'acme_openai:acme-code',
      rawModel: 'acme-code',
      apiProviderId: 'acme',
      endpointId: 'acme_openai',
      protocol: 'openai-compatible',
      supportsImages: false,
    });

    const selection = resolver.resolveSelection({
      harnessId: 'direct-openai-compatible',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    });

    expect(selection).toEqual({
      model: 'acme-code',
      apiProviderId: 'acme',
      endpointId: 'acme_openai',
      protocol: 'openai-compatible',
      isLocal: false,
      envOverrides: undefined,
    });
    expect(resolver.modelSupportsImages({
      harnessId: 'direct-openai-compatible',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    })).toBe(false);
    expect(resolver.getModelOptions('direct-openai-compatible')).toHaveLength(1);
    expect(resolver.getModelOptions('direct-openai-responses-compatible')).toHaveLength(2);
  });

  it('resolves Direct Anthropic endpoint-backed models without env overrides', () => {
    const resolver = makeResolver();
    const [option] = resolver.getModelOptions('direct-anthropic-compatible');

    expect(option).toMatchObject({
      value: 'acme_anthropic:acme-claude',
      rawModel: 'acme-claude',
      apiProviderId: 'acme',
      endpointId: 'acme_anthropic',
      protocol: 'anthropic-messages',
      supportsImages: true,
    });

    const selection = resolver.resolveSelection({
      harnessId: 'direct-anthropic-compatible',
      model: 'acme_anthropic:acme-claude',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
    });

    expect(selection).toEqual({
      model: 'acme-claude',
      apiProviderId: 'acme',
      endpointId: 'acme_anthropic',
      protocol: 'anthropic-messages',
      isLocal: false,
      envOverrides: undefined,
    });
  });

  it('builds Claude env overrides and Codex Responses routing for compatible endpoints', () => {
    const resolver = makeResolver();

    expect(resolver.resolveSelection({
      harnessId: 'claude',
      model: 'acme_anthropic:acme-claude',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
    }).envOverrides).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.acme.test/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'secret',
      ANTHROPIC_API_KEY: '',
    });

    const codexSelection = resolver.resolveSelection({
      harnessId: 'codex',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    });
    expect(codexSelection.envOverrides).toBeUndefined();
    expect(codexSelection.codexConfig).toEqual({
      config: {
        model_provider: 'garcon_acme_openai',
        model_providers: {
          garcon_acme_openai: {
            name: 'Acme',
            base_url: 'https://api.acme.test/v1',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false,
            env_key: 'GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI',
            http_headers: {
              'HTTP-Referer': 'https://github.com/cfal/garcon',
              'X-OpenRouter-Title': 'Garcon',
            },
          },
        },
      },
      env: {
        GARCON_CODEX_PROVIDER_API_KEY_ACME_OPENAI: 'secret',
      },
    });
  });

  it('omits API key env vars for blank-key endpoints', () => {
    const resolver = makeResolver();

    expect(resolver.resolveSelection({
      harnessId: 'claude',
      model: 'acme_anthropic_blank:llama3',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic_blank',
    }).envOverrides).toEqual({
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      ANTHROPIC_API_KEY: '',
    });

    const codexSelection = resolver.resolveSelection({
      harnessId: 'codex',
      model: 'acme_openai_blank:llama3',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai_blank',
    });
    expect(codexSelection.envOverrides).toBeUndefined();
    expect(codexSelection.codexConfig).toEqual({
      config: {
        model_provider: 'garcon_acme_openai_blank',
        model_providers: {
          garcon_acme_openai_blank: {
            name: 'Acme',
            base_url: 'http://localhost:11434/v1',
            wire_api: 'responses',
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
    });
  });

  it('rejects protocol-incompatible harness selections', () => {
    const resolver = makeResolver();

    expect(() => resolver.resolveSelection({
      harnessId: 'claude',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    })).toThrow(ModelSelectionError);

    expect(() => resolver.resolveSelection({
      harnessId: 'direct-anthropic-compatible',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    })).toThrow(ModelSelectionError);
  });
});
