import { describe, expect, it } from 'bun:test';
import { ApiProviderEndpointResolver, ModelSelectionError } from '../endpoint-resolver.ts';

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
  ], (agentId) => (
    agentId === 'claude' || agentId === 'direct-anthropic-compatible'
      ? ['anthropic-messages']
      : ['openai-compatible']
  ));
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
      agentId: 'direct-openai-compatible',
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
    });
    expect(resolver.modelSupportsImages({
      agentId: 'direct-openai-compatible',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    })).toBe(false);
    expect(resolver.getModelOptions('direct-openai-compatible')).toHaveLength(2);
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
      agentId: 'direct-anthropic-compatible',
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
    });
  });

  it('exposes endpoint references without building agent runtime config', () => {
    const resolver = makeResolver();

    const claudeSelection = resolver.resolveSelection({
      agentId: 'claude',
      model: 'acme_anthropic:acme-claude',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic',
    });
    const claudeReference = resolver.resolveEndpointReference(claudeSelection);
    expect(claudeReference?.apiProvider.id).toBe('acme');
    expect(claudeReference?.endpoint.id).toBe('acme_anthropic');

    const codexSelection = resolver.resolveSelection({
      agentId: 'codex',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    });
    const codexReference = resolver.resolveEndpointReference(codexSelection);
    expect(codexReference?.apiProvider.id).toBe('acme');
    expect(codexReference?.endpoint.id).toBe('acme_openai');
  });

  it('keeps blank-key endpoint selections free of runtime config', () => {
    const resolver = makeResolver();

    expect(resolver.resolveSelection({
      agentId: 'claude',
      model: 'acme_anthropic_blank:llama3',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_anthropic_blank',
    })).toMatchObject({
      model: 'llama3',
      endpointId: 'acme_anthropic_blank',
      isLocal: true,
    });

    const codexSelection = resolver.resolveSelection({
      agentId: 'codex',
      model: 'acme_openai_blank:llama3',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai_blank',
    });
    expect(codexSelection).toMatchObject({
      model: 'llama3',
      endpointId: 'acme_openai_blank',
      isLocal: true,
    });
  });

  it('rejects protocol-incompatible agent selections', () => {
    const resolver = makeResolver();

    expect(() => resolver.resolveSelection({
      agentId: 'claude',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    })).toThrow(ModelSelectionError);

    expect(() => resolver.resolveSelection({
      agentId: 'direct-anthropic-compatible',
      model: 'acme_openai:acme-code',
      apiProviderId: 'acme',
      modelEndpointId: 'acme_openai',
    })).toThrow(ModelSelectionError);
  });
});
