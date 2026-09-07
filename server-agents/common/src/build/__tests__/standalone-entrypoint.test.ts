import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSearchWorkerEntrypoints } from '../standalone-entrypoint.js';

describe('transcript search Worker entrypoint resolution', () => {
  it('uses source Worker entrypoints outside compiled mode', () => {
    const indexerSourceUrl = new URL('../../search/indexer-main.ts', import.meta.url);
    const readerSourceUrl = new URL('../../search/reader-main.ts', import.meta.url);
    expect(resolveSearchWorkerEntrypoints({ indexerSourceUrl, readerSourceUrl })).toEqual({
      indexer: indexerSourceUrl.href,
      reader: readerSourceUrl.href,
    });
  });

  it('requires complete absolute compiled manifest entries', async () => {
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, '../standalone-entrypoint.ts')).href;
    const script = `
      globalThis[Symbol.for('garcon.compiled-mode')] = true;
      globalThis[Symbol.for('garcon.embedded-search-manifest.v1')] = {
        mode: 'compiled', apiVersion: 1,
        workers: { indexer: '/tmp/indexer.js', reader: 'relative-reader.js' },
      };
      const resolver = await import(${JSON.stringify(moduleUrl)});
      resolver.resolveSearchWorkerEntrypoints({
        indexerSourceUrl: new URL('file:///source-indexer.ts'),
        readerSourceUrl: new URL('file:///source-reader.ts'),
      });
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('invalid workers/reader');
  });
});
