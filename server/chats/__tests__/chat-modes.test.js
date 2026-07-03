import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_THINKING_MODE,
  THINKING_MODE_VALUES,
  coerceThinkingMode,
  isThinkingMode,
  normalizeThinkingMode,
} from '../../../common/chat-modes.js';

describe('thinking mode normalization', () => {
  test('exposes effort-level values', () => {
    expect([...THINKING_MODE_VALUES]).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('accepts canonical values unchanged', () => {
    for (const value of THINKING_MODE_VALUES) {
      expect(normalizeThinkingMode(value)).toBe(value);
    }
  });

  test('maps legacy persisted values to effort levels', () => {
    expect(normalizeThinkingMode('think')).toBe('low');
    expect(normalizeThinkingMode('think-hard')).toBe('medium');
    expect(normalizeThinkingMode('think-harder')).toBe('high');
    expect(normalizeThinkingMode('ultrathink')).toBe('max');
  });

  test('legacy values are not valid canonical modes', () => {
    expect(isThinkingMode('ultrathink')).toBe(false);
    expect(isThinkingMode('max')).toBe(true);
  });

  test('coerceThinkingMode returns null for unknown values', () => {
    expect(coerceThinkingMode('mega')).toBeNull();
    expect(coerceThinkingMode(undefined)).toBeNull();
    expect(normalizeThinkingMode('mega')).toBe(DEFAULT_THINKING_MODE);
  });
});
