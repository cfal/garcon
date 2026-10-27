import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { commandOutput, sha256 } from './artifacts.js';
import { CURRENT_ARTIFACT } from '../support/source-artifact.js';

const output = process.argv[2];
assert(output, 'Usage: bun integration-tests/compatibility/archive.ts <source.tar.gz>');
assert.equal(await commandOutput(['git', 'diff', 'HEAD', '--name-only']), '', 'Commit and validate implementation before archiving');
const sourceSha = await commandOutput(['git', 'rev-parse', 'HEAD']);
const sourceTime = await commandOutput(['git', 'show', '-s', '--format=%ct', sourceSha]);
const scratch = join(homedir(), 'tmp');
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(join(scratch, 'garcon-baseline-archive-'));
try {
  const lockfiles = Object.fromEntries(await Promise.all(['bun.lock', 'integration-tests/bun.lock'].map(async file =>
    [file, sha256(await readFile(join(CURRENT_ARTIFACT.repoRoot, file)))])));
  const metadata = { core: 1, sourceSha, bunVersion: Bun.version, lockfiles };
  await mkdir(join(root, 'garcon'));
  await writeFile(join(root, 'garcon/compatibility-artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const tar = join(root, 'source.tar');
  await commandOutput(['git', 'archive', '--format=tar', '--prefix=garcon/', '--output', tar, sourceSha]);
  await commandOutput(['tar', '-rf', tar, `--mtime=@${sourceTime}`, '--owner=0', '--group=0', '--numeric-owner',
    '--mode=0644', '-C', root, 'garcon/compatibility-artifact.json']);
  await mkdir(dirname(resolve(output)), { recursive: true });
  const compressed = Bun.spawn(['gzip', '-n', '-c', tar], { stdout: Bun.file(resolve(output)), stderr: 'pipe' });
  const stderr = await new Response(compressed.stderr).text();
  assert.equal(await compressed.exited, 0, stderr);
  console.log(JSON.stringify({ ...metadata, archiveSha256: sha256(await readFile(output)) }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
