import { describe, expect, it } from 'bun:test';
import { resolveClaudeModel } from '../model-context.js';

describe('resolveClaudeModel', () => {
  for (const model of ['', 'sonnet', 'gateway/model', 'gateway/model[1m]', 'gateway/model[preview]']) {
    it(`preserves the native model spelling ${JSON.stringify(model)}`, () => {
      expect(resolveClaudeModel(model)).toEqual({ model, autoCompactWindow: null });
    });
  }

  for (const [suffix, tokens] of [['100k', 100_000], ['922k', 922_000], ['1000k', 1_000_000], ['0922K', 922_000]]) {
    it(`resolves [${suffix}] without looking up the model`, () => {
      expect(resolveClaudeModel(`gateway/custom-model[${suffix}]`)).toEqual({
        model: 'gateway/custom-model[1m]',
        autoCompactWindow: tokens,
      });
    });
  }

  for (const model of [
    'custom[0k]', 'custom[99k]', 'custom[1001k]', 'custom[999999999999999999999k]',
    '[922k]', 'custom[1m][922k]', 'custom[922k][1m]', 'custom[922k]]',
    'custom[[922k]', 'custom[922k', 'custom922k]', 'custom[922k]extra',
  ]) {
    it(`rejects an invalid context annotation: ${model}`, () => {
      expect(() => resolveClaudeModel(model)).toThrow('context suffix');
    });
  }
});
