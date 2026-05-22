import { describe, expect, it } from 'bun:test';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';

describe('resolveEffectiveGenerationConfig', () => {
  it('disables generation when no agent is authenticated and no settings were persisted', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        factory: { authenticated: false },
      },
      modelsByAgent: { opencode: [], factory: [] },
    });

    expect(result).toEqual({
      enabled: false,
      provider: 'claude',
      model: 'haiku',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'auto',
    });
  });

  it('auto-selects codex defaults when codex is the highest authenticated agent', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: true },
        opencode: { authenticated: true },
        factory: { authenticated: false },
      },
      modelsByAgent: { opencode: [], factory: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'codex',
      model: 'gpt-5.5',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'auto',
    });
  });

  it('auto-selects Direct Anthropic endpoint models before Codex when ready', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: true },
      },
      readinessByAgent: {
        'direct-anthropic-compatible': { ready: true },
      },
      modelsByAgent: {
        'direct-anthropic-compatible': [
          { value: 'acme_anthropic:acme-sonnet', label: 'Acme: Acme Sonnet' },
        ],
      },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'direct-anthropic-compatible',
      model: 'acme_anthropic:acme-sonnet',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'auto',
    });
  });

  it('prefers OpenCode non-R1 defaults when OpenCode is selected', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: true },
        factory: { authenticated: false },
      },
      modelsByAgent: {
        opencode: [
          { value: 'deepseek-r1', label: 'DeepSeek R1' },
          { value: 'deepseek-v3', label: 'DeepSeek V3' },
          { value: 'openai/gpt-4.1', label: 'GPT-4.1' },
        ],
      },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'opencode',
      model: 'deepseek-v3',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'auto',
    });
  });

  it('does not auto-select OpenCode when no OpenCode models were discovered', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: true },
        factory: { authenticated: false },
      },
      modelsByAgent: { opencode: [] },
    });

    expect(result).toEqual({
      enabled: false,
      provider: 'claude',
      model: 'haiku',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'auto',
    });
  });

  it('respects explicitly persisted settings even without authenticated agents', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'opencode', model: 'openai/gpt-4.1' },
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        factory: { authenticated: false },
      },
      modelsByAgent: { opencode: [], factory: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'opencode',
      model: 'openai/gpt-4.1',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'manual',
    });
  });

  it('preserves a persisted amp agent and fills its default model', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'amp' },
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        amp: { authenticated: false },
      },
      modelsByAgent: { opencode: [], amp: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'amp',
      model: 'smart',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'manual',
    });
  });

  it('preserves a persisted factory agent and fills its default model', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'factory' },
      authByAgent: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        amp: { authenticated: false },
        factory: { authenticated: false },
      },
      modelsByAgent: { opencode: [], amp: [], factory: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'factory',
      model: 'claude-opus-4-6',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'manual',
    });
  });

  it('uses dynamic agent model defaults from catalog-shaped model maps', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'direct-openai-compatible' },
      authByAgent: {},
      modelsByAgent: {
        'direct-openai-compatible': [
          { value: 'zai_openai:glm-5.1', label: 'Z.AI: GLM-5.1' },
        ],
      },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'direct-openai-compatible',
      model: 'zai_openai:glm-5.1',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      source: 'manual',
    });
  });
});
