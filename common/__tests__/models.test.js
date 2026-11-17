import { describe, expect, it } from 'bun:test';
import { CODEX_MODELS, isCodexSolModel } from '../models.ts';

describe('Codex model options', () => {
  it.each([
    ['gpt-6.2-sol', 'GPT-6.2-Sol'],
    ['gpt-6.2-astra', 'GPT-6.2-Astra'],
  ])('offers %s without changing the default', (value, label) => {
    expect(CODEX_MODELS.OPTIONS.find((model) => model.value === value))
      .toEqual({ value, label, supportsImages: true });
    expect(CODEX_MODELS.DEFAULT).toBe('gpt-6-sol');
  });

  it.each(['gpt-6.2-sol', 'endpoint:gpt-6.2-sol'])('recognizes Sol %s', (model) => {
    expect(isCodexSolModel(model)).toBe(true);
  });

  it.each(['gpt-6.2-astra', 'endpoint:gpt-6.2-astra', 'not-gpt-6.2-sol', undefined])(
    'does not classify %s as Sol', (model) => {
      expect(isCodexSolModel(model)).toBe(false);
    },
  );
});
