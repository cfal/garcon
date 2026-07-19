import { describe, expect, it } from 'bun:test';
import { THINKING_MODE_VALUES } from '@garcon/common/chat-modes';
import { resolveDirectExplicitEffort } from '../reasoning-effort.ts';

describe('resolveDirectExplicitEffort', () => {
  it('omits Default and invalid values', () => {
    expect(resolveDirectExplicitEffort(undefined)).toBeUndefined();
    expect(resolveDirectExplicitEffort(null)).toBeUndefined();
    expect(resolveDirectExplicitEffort('none')).toBeUndefined();
    expect(resolveDirectExplicitEffort('invalid')).toBeUndefined();
  });

  it('preserves every explicit canonical effort', () => {
    for (const effort of THINKING_MODE_VALUES.filter((value) => value !== 'none')) {
      expect(resolveDirectExplicitEffort(effort)).toBe(effort);
    }
  });

  it('normalizes persisted legacy aliases', () => {
    expect(resolveDirectExplicitEffort('think')).toBe('low');
    expect(resolveDirectExplicitEffort('think-hard')).toBe('medium');
    expect(resolveDirectExplicitEffort('think-harder')).toBe('high');
    expect(resolveDirectExplicitEffort('ultrathink')).toBe('max');
  });
});
