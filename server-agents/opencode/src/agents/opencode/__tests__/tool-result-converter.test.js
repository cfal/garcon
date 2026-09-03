import { describe, it, expect } from 'bun:test';
import { normalizeOpenCodeToolResultContent } from '../tool-result-converter.js';

describe('normalizeOpenCodeToolResultContent', () => {
  it('maps glob output paths and metadata count', () => {
    const content = normalizeOpenCodeToolResultContent('glob', {
      status: 'completed',
      output: '/repo/src/a.ts\n/repo/src/b.ts',
      metadata: { count: 2, truncated: false },
    });
    expect(content).toEqual({
      filenames: ['/repo/src/a.ts', '/repo/src/b.ts'],
      numFiles: 2,
    });
  });

  it('maps empty glob results without inventing filenames', () => {
    const content = normalizeOpenCodeToolResultContent('glob', {
      status: 'completed',
      output: 'No files found',
      metadata: { count: 0, truncated: false },
    });
    expect(content).toEqual({ filenames: [], numFiles: 0 });
  });

  it('drops the glob truncation note and trusts metadata count', () => {
    const content = normalizeOpenCodeToolResultContent('glob', {
      status: 'completed',
      output: '/repo/a.ts\n(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)',
      metadata: { count: 100, truncated: true },
    });
    expect(content).toEqual({ filenames: ['/repo/a.ts'], numFiles: 100 });
  });

  it('maps grep path headings and metadata matches', () => {
    const content = normalizeOpenCodeToolResultContent('grep', {
      status: 'completed',
      output: [
        'Found 3 matches',
        '/repo/src/a.ts:',
        '  Line 10: export const a',
        '  Line 12: export const b',
        '',
        '/repo/src/b.ts:',
        '  Line 2: export const c',
      ].join('\n'),
      metadata: { matches: 3, truncated: false },
    });
    expect(content).toEqual({
      filenames: ['/repo/src/a.ts', '/repo/src/b.ts'],
      numFiles: 2,
      totalMatches: 3,
    });
  });

  it('falls back to parsed paths when glob metadata is absent', () => {
    const content = normalizeOpenCodeToolResultContent('glob', {
      status: 'completed',
      output: '/repo/a.ts\n/repo/b.ts',
    });
    expect(content).toEqual({ filenames: ['/repo/a.ts', '/repo/b.ts'], numFiles: 2 });
  });

  it('passes through non-search outputs as raw text', () => {
    const content = normalizeOpenCodeToolResultContent('read', {
      status: 'completed',
      output: '     1\tconst a = 1',
    });
    expect(content).toEqual({ raw: '     1\tconst a = 1' });
  });

  it('normalizes tool names case-insensitively', () => {
    const content = normalizeOpenCodeToolResultContent('Glob', {
      status: 'completed',
      output: '/repo/a.ts',
      metadata: { count: 1 },
    });
    expect(content.numFiles).toBe(1);
  });

  it('accepts raw string state without object wrapper', () => {
    const content = normalizeOpenCodeToolResultContent('glob', '/repo/a.ts\n/repo/b.ts');
    expect(content).toEqual({ filenames: ['/repo/a.ts', '/repo/b.ts'], numFiles: 2 });
  });

  it('accepts glob-tool-use canonical tool type', () => {
    const content = normalizeOpenCodeToolResultContent('glob-tool-use', {
      output: '/repo/a.ts',
      metadata: { count: 1 },
    });
    expect(content).toEqual({ filenames: ['/repo/a.ts'], numFiles: 1 });
  });

  it('accepts grep-tool-use and falls back to parsed match count from header', () => {
    const content = normalizeOpenCodeToolResultContent('grep-tool-use', {
      output: [
        'Found 2 matches',
        '/repo/src/a.ts:',
        '  Line 1: first',
        '  Line 2: second',
      ].join('\n'),
    });
    expect(content).toEqual({
      filenames: ['/repo/src/a.ts'],
      numFiles: 1,
      totalMatches: 2,
    });
  });

  it('preserves paths with parentheses that are not truncation notes', () => {
    const content = normalizeOpenCodeToolResultContent('glob', {
      output: '/repo/src/(auth)/login.ts\n(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)',
      metadata: { count: 1, truncated: true },
    });
    expect(content).toEqual({
      filenames: ['/repo/src/(auth)/login.ts'],
      numFiles: 1,
    });
  });

  it('does not parse paths out of error-state search output', () => {
    const content = normalizeOpenCodeToolResultContent('grep', {
      status: 'error',
      output: '/repo/src/a.ts:',
      error: 'pattern is required',
    });
    expect(content).toEqual({ raw: '/repo/src/a.ts:' });
  });

  it('maps glob filenames array fast-path with top-level count', () => {
    const content = normalizeOpenCodeToolResultContent('glob', {
      filenames: ['/repo/a.ts', '/repo/b.ts'],
      numFiles: 2,
      metadata: { count: 99 },
    });
    expect(content).toEqual({ filenames: ['/repo/a.ts', '/repo/b.ts'], numFiles: 2 });
  });

  it('handles CRLF and array-valued outputs', () => {
    const crlf = normalizeOpenCodeToolResultContent('glob', {
      output: '/repo/a.ts\r\n/repo/b.ts',
      metadata: { count: 2 },
    });
    expect(crlf).toEqual({ filenames: ['/repo/a.ts', '/repo/b.ts'], numFiles: 2 });

    const arrayed = normalizeOpenCodeToolResultContent('grep', {
      output: ['Found 1 matches', '/repo/a.ts:', '  Line 1: x'],
      metadata: { matches: 1 },
    });
    expect(arrayed).toEqual({ filenames: ['/repo/a.ts'], numFiles: 1, totalMatches: 1 });
  });

  it('dedupes repeated grep headings while preserving metadata count', () => {
    const content = normalizeOpenCodeToolResultContent('grep', {
      output: [
        'Found 3 matches',
        '/repo/src/a.ts:',
        '  Line 10: first',
        '/repo/src/a.ts:',
        '  Line 12: second',
        '/repo/src/b.ts:',
        '  Line 2: third',
      ].join('\n'),
      metadata: { matches: 3 },
    });
    expect(content).toEqual({
      filenames: ['/repo/src/a.ts', '/repo/src/b.ts'],
      numFiles: 2,
      totalMatches: 3,
    });
  });
});
