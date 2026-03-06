import { describe, it, expect } from 'bun:test';
import path from 'path';
import { normalizePath } from '../shared.js';

describe('normalizePath', () => {
  it('returns empty string for empty or non-string input', () => {
    expect(normalizePath('')).toBe('');
    expect(normalizePath('   ')).toBe('');
    expect(normalizePath(null)).toBe('');
  });

  it('trims and resolves relative paths', () => {
    const input = ' ./tmp/../tmp/work ';
    expect(normalizePath(input)).toBe(path.resolve('./tmp/work'));
  });

  it('strips long path prefix', () => {
    const longPath = '\\\\?\\' + path.resolve('.');
    expect(normalizePath(longPath)).toBe(path.resolve('.'));
  });
});
