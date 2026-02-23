import { describe, it, expect } from 'bun:test';
import path from 'path';
import { normalizeComparablePath } from '../shared.js';

describe('normalizeComparablePath', () => {
  it('returns empty string for empty or non-string input', () => {
    expect(normalizeComparablePath('')).toBe('');
    expect(normalizeComparablePath('   ')).toBe('');
    expect(normalizeComparablePath(null)).toBe('');
  });

  it('trims and resolves relative paths', () => {
    const input = ' ./tmp/../tmp/work ';
    expect(normalizeComparablePath(input)).toBe(path.resolve('./tmp/work'));
  });

  it('strips long path prefix', () => {
    const longPath = '\\\\?\\' + path.resolve('.');
    expect(normalizeComparablePath(longPath)).toBe(path.resolve('.'));
  });
});
