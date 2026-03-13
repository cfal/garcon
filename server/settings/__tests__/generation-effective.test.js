import { describe, expect, it } from 'bun:test';
import { resolveEffectiveGenerationConfig } from '../generation-effective.js';

describe('resolveEffectiveGenerationConfig', () => {
  it('disables generation when no provider is authenticated and no settings were persisted', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByProvider: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
      },
      modelsByProvider: { opencode: [] },
    });

    expect(result).toEqual({
      enabled: false,
      provider: 'claude',
      model: 'haiku',
      source: 'auto',
    });
  });

  it('auto-selects codex defaults when codex is the highest authenticated provider', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByProvider: {
        claude: { authenticated: false },
        codex: { authenticated: true },
        opencode: { authenticated: true },
      },
      modelsByProvider: { opencode: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'codex',
      model: 'gpt-5.1-codex-mini',
      source: 'auto',
    });
  });

  it('prefers OpenCode non-R1 defaults when OpenCode is selected', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: {},
      authByProvider: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: true },
      },
      modelsByProvider: {
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
      source: 'auto',
    });
  });

  it('respects explicitly persisted settings even without authenticated providers', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'opencode', model: 'openai/gpt-4.1' },
      authByProvider: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
      },
      modelsByProvider: { opencode: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'opencode',
      model: 'openai/gpt-4.1',
      source: 'manual',
    });
  });

  it('preserves a persisted amp provider and fills its default model', () => {
    const result = resolveEffectiveGenerationConfig({
      persisted: { enabled: true, provider: 'amp' },
      authByProvider: {
        claude: { authenticated: false },
        codex: { authenticated: false },
        opencode: { authenticated: false },
        amp: { authenticated: false },
      },
      modelsByProvider: { opencode: [], amp: [] },
    });

    expect(result).toEqual({
      enabled: true,
      provider: 'amp',
      model: 'default',
      source: 'manual',
    });
  });
});
