import { describe, expect, it } from 'bun:test';
import {
  resolveOpenCodeThinkingVariant,
  thinkingModesFromVariants,
} from '../thinking-variant.js';

describe('thinkingModesFromVariants', () => {
  it('keeps recognized effort names in ladder order', () => {
    expect(thinkingModesFromVariants({
      high: {}, medium: {}, thinking: {}, xhigh: {},
    })).toEqual(['medium', 'high', 'xhigh']);
  });

  it('keeps a literal none variant ahead of ladder modes', () => {
    expect(thinkingModesFromVariants({ none: {}, high: {} })).toEqual(['none', 'high']);
  });

  it('returns undefined without recognized names', () => {
    expect(thinkingModesFromVariants({ thinking: {} })).toBeUndefined();
    expect(thinkingModesFromVariants('nope')).toBeUndefined();
  });
});

describe('resolveOpenCodeThinkingVariant', () => {
  it('omits a variant for the default none mode unless the model declares none', () => {
    expect(resolveOpenCodeThinkingVariant('none', ['none', 'high'])).toBe('none');
    expect(resolveOpenCodeThinkingVariant('none', ['low', 'high'])).toBeUndefined();
    expect(resolveOpenCodeThinkingVariant('none', undefined)).toBeUndefined();
    expect(resolveOpenCodeThinkingVariant(undefined, ['high'])).toBeUndefined();
  });

  it('passes an exact declared mode through', () => {
    expect(resolveOpenCodeThinkingVariant('high', ['low', 'high'])).toBe('high');
  });

  it('passes the mode through when the declared set is unknown', () => {
    expect(resolveOpenCodeThinkingVariant('xhigh', undefined)).toBe('xhigh');
  });

  it('steps a request above the declared ceiling down to the highest declared mode', () => {
    expect(resolveOpenCodeThinkingVariant('max', ['low', 'medium', 'high'])).toBe('high');
    expect(resolveOpenCodeThinkingVariant('xhigh', ['low', 'medium'])).toBe('medium');
    expect(resolveOpenCodeThinkingVariant('ultra', ['low', 'high', 'max'])).toBe('max');
    expect(resolveOpenCodeThinkingVariant('ultra', undefined)).toBe('max');
  });

  it('omits a variant when the model declares no ladder modes', () => {
    expect(resolveOpenCodeThinkingVariant('high', ['none'])).toBeUndefined();
  });
});
