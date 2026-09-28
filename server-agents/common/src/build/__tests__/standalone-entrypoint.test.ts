import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveWorkerEntrypoint } from '../standalone-entrypoint.js';

describe('Worker entrypoint resolution', () => {
  it('uses source Worker entrypoints outside compiled mode', () => {
    const sourceUrl = new URL('../../search/indexer-main.ts', import.meta.url);
    expect(resolveWorkerEntrypoint('search-indexer', sourceUrl)).toBe(sourceUrl.href);
  });

  it('requires complete absolute compiled manifest entries', async () => {
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, '../standalone-entrypoint.ts')).href;
    const run = async (resolve: string) => {
      const script = `
        globalThis[Symbol.for('garcon.compiled-mode')] = true;
        globalThis[Symbol.for('garcon.embedded-workers.v1')] = {
          mode: 'compiled', apiVersion: 1,
          workers: { 'search-indexer': '/tmp/indexer.js', 'search-reader': 'relative-reader.js' },
        };
        const resolver = await import(${JSON.stringify(moduleUrl)});
        console.log(resolver.resolveWorkerEntrypoint(${JSON.stringify(resolve)}, new URL('file:///source.ts')));
      `;
      const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };

    expect(await run('search-indexer')).toMatchObject({ exitCode: 0, stdout: '/tmp/indexer.js\n' });
    const relative = await run('search-reader');
    expect(relative.exitCode).not.toBe(0);
    expect(relative.stderr).toContain('invalid workers/search-reader');
    const missing = await run('token-fitting');
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('missing workers/token-fitting');
  });
});
