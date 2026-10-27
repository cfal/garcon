import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandOutput, downloadArchive, prepareArtifacts, sha256, validateManifest, type BaselineManifest } from '../artifacts.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('bootstrap is explicit and cannot extend into another release', () => {
  const manifest = { core: 1, stage: 'bootstrap', bootstrapPackageVersion: '0.3.4', baselines: [] } satisfies BaselineManifest;
  expect(validateManifest(manifest, '0.3.4')).toEqual(manifest);
  expect(() => validateManifest(manifest, '0.3.5')).toThrow('Publish and pin');
  expect(() => validateManifest({ ...manifest, stage: 'cross-build' }, '0.3.5')).toThrow('immutable baseline');
  expect(() => validateManifest({ core: 1, baselines: [] }, '0.3.4')).toThrow();
});

test('missing and corrupt immutable archives fail instead of using the current checkout', async () => {
  const scratch = join(homedir(), 'tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'garcon-artifact-test-'));
  const bytes = new TextEncoder().encode('Synthetic immutable archive');
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: request =>
    new URL(request.url).pathname === '/missing' ? new Response(null, { status: 404 }) : new Response(bytes) });
  try {
    const destination = join(directory, 'archive');
    const url = `http://127.0.0.1:${server.port}`;
    const missing = await rejectionOf(downloadArchive(`${url}/missing`, destination, sha256(bytes)));
    expect(missing).toMatchObject({ message: 'Baseline download failed: 404' });
    const corrupt = await rejectionOf(downloadArchive(`${url}/archive`, destination, '0'.repeat(64)));
    expect(corrupt).toBeInstanceOf(Error);
    expect((corrupt as Error).message).toContain('Immutable artifact digest mismatch');
    await downloadArchive(`${url}/archive`, destination, sha256(bytes));
    expect(new Uint8Array(await readFile(destination))).toEqual(bytes);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test('cross-build pins source, runtime and both independent lockfiles', () => {
  const baseline = {
    sourceSha: 'a'.repeat(40), archiveUrl: 'https://github.com/cfal/garcon/releases/download/executor-core-1-baseline/source.tar.gz',
    archiveSha256: 'b'.repeat(64), lockfiles: { 'bun.lock': 'c'.repeat(64), 'integration-tests/bun.lock': 'd'.repeat(64) },
    runtime: { version: '1.4.3', archiveUrl: 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip', archiveSha256: 'e'.repeat(64) },
  };
  expect(validateManifest({ core: 1, stage: 'cross-build', baselines: [baseline] }, '0.3.5').baselines).toEqual([baseline]);
  for (const invalid of [{ ...baseline, sourceSha: 'HEAD' }, { ...baseline, archiveSha256: '' },
    { ...baseline, lockfiles: {} }, { ...baseline, runtime: { ...baseline.runtime, archiveUrl: 'file:///synthetic' } }]) {
    expect(() => validateManifest({ core: 1, stage: 'cross-build', baselines: [invalid] }, '0.3.5')).toThrow();
  }
});

test.each(['same revision', 'missing', 'corrupt'])('artifact selection rejects a %s baseline without fallback', async failure => {
  const current = await commandOutput(['git', 'rev-parse', 'HEAD']);
  const baseline = {
    sourceSha: failure === 'same revision' ? current : 'a'.repeat(40),
    archiveUrl: 'https://example.invalid/source.tar.gz', archiveSha256: 'b'.repeat(64),
    lockfiles: { 'bun.lock': 'c'.repeat(64), 'integration-tests/bun.lock': 'd'.repeat(64) },
    runtime: { version: '1.4.3', archiveUrl: 'https://example.invalid/runtime.zip', archiveSha256: 'e'.repeat(64) },
  };
  const download = spyOn(globalThis, 'fetch').mockResolvedValue(
    failure === 'missing' ? new Response(null, { status: 404 }) : new Response('Synthetic corrupt archive'));
  try {
    await expect(prepareArtifacts({ core: 1, stage: 'cross-build', baselines: [baseline] })).rejects.toThrow(
      failure === 'same revision' ? 'distinct source revisions'
        : failure === 'missing' ? 'Baseline download failed: 404' : 'Immutable artifact digest mismatch',
    );
    expect(download).toHaveBeenCalledTimes(failure === 'same revision' ? 0 : 1);
  } finally { download.mockRestore(); }
});
