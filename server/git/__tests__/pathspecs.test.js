import { describe, expect, it } from 'bun:test';
import { chunkGitPathspecs, exactGitPathspecs, literalGitPathspec } from '../pathspecs.js';

describe('literalGitPathspec', () => {
  it('disables pathspec magic for user-controlled paths', () => {
    expect(literalGitPathspec('src/[draft]*.ts')).toBe(':(literal)src/[draft]*.ts');
  });

  it('excludes descendants when selecting one exact file', () => {
    expect(exactGitPathspecs('bin/tool')).toEqual([
      ':(literal)bin/tool',
      ':(exclude,literal)bin/tool/',
    ]);
  });
});

describe('chunkGitPathspecs', () => {
  it('keeps ordinary selections in one git command', () => {
    expect(chunkGitPathspecs(['a.ts', 'src/b.ts'])).toEqual([['a.ts', 'src/b.ts']]);
  });

  it('splits large selections before argv size becomes risky', () => {
    const paths = Array.from({ length: 257 }, (_, index) => `src/file-${index}.ts`);

    const chunks = chunkGitPathspecs(paths);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(256);
    expect(chunks[1]).toEqual(['src/file-256.ts']);
  });

  it('splits long pathspec lists by byte size', () => {
    const paths = Array.from({ length: 10 }, (_, index) => `${'deep/'.repeat(400)}file-${index}.ts`);

    const chunks = chunkGitPathspecs(paths);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(paths);
  });
});
