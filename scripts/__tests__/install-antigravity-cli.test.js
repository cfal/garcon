import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAntigravityCli } from '../install-antigravity-cli.ts';

it.skipIf(process.platform !== 'linux')('publishes a verified binary for concurrent installers and reuses it without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'test-agy-install-'));
  try {
    const member = 'antigravity';
    const contents = '#!/bin/sh\nexit 0\n';
    const archive = join(root, 'fixture.tar.gz');
    const cache = join(root, 'cache');
    await writeFile(join(root, member), contents);
    expect(Bun.spawnSync(['tar', '-czf', archive, '-C', root, member]).exitCode).toBe(0);
    const digest = bytes => createHash('sha512').update(bytes).digest('hex');
    const release = {
      version: 'fixture', platform: `${process.platform}-${process.arch}`, url: pathToFileURL(archive).href, member,
      sha512: digest(await Bun.file(archive).bytes()), binarySha512: digest(contents),
    };
    const [first, second] = await Promise.all([installAntigravityCli(cache, release), installAntigravityCli(cache, release)]);
    expect(first).toBe(second);
    expect(await readdir(join(cache, 'fixture'))).toEqual(['agy']);
    expect(await Bun.file(first).text()).toBe(contents);
    await chmod(first, 0o555);
    await installAntigravityCli(cache, release);
    expect((await stat(first)).mode & 0o777).toBe(0o555);
    await chmod(first, 0o644);
    await installAntigravityCli(cache, release);
    expect((await stat(first)).mode & 0o111).toBe(0o111);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
