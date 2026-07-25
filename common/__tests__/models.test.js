import { describe, expect, test } from 'bun:test';
import { CLAUDE_MODELS } from '../models.ts';

describe('CLAUDE_MODELS', () => {
  test('exposes Opus 5 as the default while retaining the legacy alias', () => {
    expect(CLAUDE_MODELS.DEFAULT).toBe('claude-opus-5');
    expect(CLAUDE_MODELS.OPTIONS).toContainEqual({
      value: 'claude-opus-5',
      label: 'Opus 5',
      supportsImages: true,
    });
    expect(CLAUDE_MODELS.OPTIONS).toContainEqual({
      value: 'opus',
      label: 'Opus',
      supportsImages: true,
    });
  });
});