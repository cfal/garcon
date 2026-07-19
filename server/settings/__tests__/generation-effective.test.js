import { describe, expect, it } from 'bun:test';
import { resolveEffectiveGenerationConfig } from '../generation-effective.ts';

const base = {
  persisted: undefined,
  authByAgent: {},
  readinessByAgent: {},
  modelsByAgent: {
    alpha: [{ value: 'alpha-default', label: 'Alpha' }],
    beta: [{ value: 'beta-default', label: 'Beta' }],
  },
  generationByAgent: {
    alpha: { priority: 20, model: 'alpha-default' },
    beta: { priority: 10, model: 'beta-default' },
  },
};

describe('resolveEffectiveGenerationConfig', () => {
  it('uses catalog generation priority without provider IDs in core', () => {
    expect(resolveEffectiveGenerationConfig({
      ...base,
      readinessByAgent: { alpha: { ready: true }, beta: { ready: true } },
    })).toMatchObject({ enabled: true, agentId: 'beta', model: 'beta-default', source: 'auto' });
  });

  it('does not auto-enable when no generation integration is ready', () => {
    expect(resolveEffectiveGenerationConfig(base)).toMatchObject({
      enabled: false,
      agentId: 'alpha',
      model: 'alpha-default',
    });
  });

  it('preserves a valid explicit selection and endpoint routing', () => {
    expect(resolveEffectiveGenerationConfig({
      ...base,
      persisted: {
        enabled: true,
        agentId: 'alpha',
        model: 'alpha-default',
        apiProviderId: 'provider',
        modelEndpointId: 'endpoint',
        modelProtocol: 'openai-compatible',
        thinkingMode: 'max',
      },
    })).toEqual({
      enabled: true,
      agentId: 'alpha',
      model: 'alpha-default',
      apiProviderId: 'provider',
      modelEndpointId: 'endpoint',
      modelProtocol: 'openai-compatible',
      thinkingMode: 'max',
      source: 'manual',
    });
  });

  it('replaces a model that is not in the selected integration catalog', () => {
    expect(resolveEffectiveGenerationConfig({
      ...base,
      persisted: { agentId: 'beta', model: 'alpha-default' },
    })).toMatchObject({ agentId: 'beta', model: 'beta-default' });
  });

  it('accepts a catalog raw model alias', () => {
    expect(resolveEffectiveGenerationConfig({
      ...base,
      modelsByAgent: { alpha: [{ value: 'endpoint::model', rawModel: 'model', label: 'Model' }] },
      persisted: { agentId: 'alpha', model: 'model' },
    })).toMatchObject({ agentId: 'alpha', model: 'model' });
  });
});
