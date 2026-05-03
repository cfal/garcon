import { describe, expect, it } from 'bun:test';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';

describe('resolveEffectiveGenerationConfig', () => {
  it('disables generation when no harness is authenticated and no settings were persisted', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        factory: { authenticated: false },
      },
      modelsByHarness: { opencode: [], factory: [] },
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

  it('auto-selects codex defaults when codex is the highest authenticated harness', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: true },
        opencode: { authenticated: true },
        factory: { authenticated: false },
      },
      modelsByHarness: { opencode: [], factory: [] },
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

  it('prefers OpenCode non-R1 defaults when OpenCode is selected', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: true },
        factory: { authenticated: false },
      },
      modelsByHarness: {
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
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: true },
        factory: { authenticated: false },
      },
      modelsByHarness: { opencode: [] },
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

  it('respects explicitly persisted settings even without authenticated harnesses', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'opencode', model: 'openai/gpt-4.1' },
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        factory: { authenticated: false },
      },
      modelsByHarness: { opencode: [], factory: [] },
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

  it('preserves a persisted amp harness and fills its default model', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'amp' },
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        amp: { authenticated: false },
      },
      modelsByHarness: { opencode: [], amp: [] },
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

  it('preserves a persisted factory harness and fills its default model', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'factory' },
      authByHarness: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        amp: { authenticated: false },
        factory: { authenticated: false },
      },
      modelsByHarness: { opencode: [], amp: [], factory: [] },
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

  it('uses dynamic harness model defaults from catalog-shaped model maps', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'direct-openai-compatible' },
      authByHarness: {},
      modelsByHarness: {
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
