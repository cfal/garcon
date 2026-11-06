import { expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleRelease, releaseInputs, verifyRelease } from '../release-assets.js';
import { inspectArtifact, targets } from '../../native/scripts/distribution.js';

function command(args, cwd) {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'garcon-release-'));
  try {
    await writeFile(join(directory, 'package.json'), '{"version":"0.4.0"}');
    await writeFile(join(directory, 'LICENSE'), 'Synthetic license\n');
    command(['git', 'init', '-q'], directory);
    command(['git', 'add', 'package.json', 'LICENSE'], directory);
    command(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic release'], directory);
    const sourceCommit = command(['git', 'rev-parse', 'HEAD'], directory);
    const input = join(directory, 'input');
    const output = join(directory, 'output');
    for (const entry of releaseInputs('0.4.0')) {
      const folder = join(input, entry.artifact, 'nested');
      await mkdir(folder, { recursive: true });
      if (!entry.target) {
        await writeFile(join(folder, entry.artifact), 'synthetic executable');
        continue;
      }
      const target = targets[entry.target];
      const artifacts = [];
      for (const format of target.formats) {
        const bytes = Buffer.alloc(1024);
        if (format === 'deb') bytes.write('!<arch>\n');
        if (format === 'nsis') bytes.write('MZ');
        if (format === 'dmg') bytes.write('koly', 512);
        if (format === 'appimage') {
          bytes.set([0x7f, 0x45, 0x4c, 0x46]);
          bytes.set([0x41, 0x49, 2], 8);
        }
        if (['apk', 'simulator'].includes(format)) bytes.set([0x50, 0x4b, 3, 4]);
        const path = join(folder, `synthetic.${format}`);
        await writeFile(path, bytes);
        const artifact = await inspectArtifact(path, format);
        if (format === 'apk') artifact.signerCertificateSha256 = 'ab'.repeat(32);
        artifacts.push(artifact);
      }
      await writeFile(join(folder, `distribution-${entry.target}.json`), JSON.stringify({
        schemaVersion: 1, version: '0.4.0', target: entry.target,
        distribution: 'preview-only', releaseAllowed: false,
        signing: entry.target === 'android' ? 'ephemeral-debug-key-not-stable' : 'unsigned-not-distribution-verified',
        runtimeGate: target.runtime, runtimeResult: 'not-attested-by-artifact-validation',
        releaseBlockers: target.blockers, artifacts,
      }));
    }
    await run({ input, output, directory, sourceCommit, version: '0.4.0', repository: 'synthetic/project' });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('assembles exact archives, preserves preview manifests, and checksums final bytes', () => fixture(async options => {
  const manifest = await assembleRelease(options);
  expect(manifest.sourceCommit).toBe(options.sourceCommit);
  expect(manifest.artifacts).toHaveLength(10);
  expect(await readdir(options.output)).toHaveLength(12);
  expect(await verifyRelease(options.output, options)).toEqual(manifest);
  command(['sha256sum', '--check', '--strict', 'SHA256SUMS'], options.output);
  const checksumFiles = (await readFile(join(options.output, 'SHA256SUMS'), 'utf8'))
    .trimEnd().split('\n').map(line => line.split('  ')[1]);
  expect(checksumFiles).toEqual([...checksumFiles].sort((a, b) => a.localeCompare(b)));
  const native = releaseInputs('0.4.0').find(entry => entry.target === 'android');
  expect(command(['unzip', '-Z1', join(options.output, native.archive)], options.directory).split('\n'))
    .toEqual(['distribution-android.json', 'synthetic.apk', 'LICENSE']);
  const archived = command(['unzip', '-p', join(options.output, native.archive), 'distribution-android.json'], options.directory);
  expect(JSON.parse(archived).releaseAllowed).toBe(false);
  const source = command(['tar', '-tzf', join(options.output, 'garcon-v0.4.0-source.tar.gz')], options.directory);
  expect(source).toContain('garcon-v0.4.0/package.json');
  expect(source).not.toContain('input/');
  const linux = releaseInputs('0.4.0')[0];
  const extracted = join(options.directory, 'extracted');
  command(['unzip', '-q', join(options.output, linux.archive), '-d', extracted], options.directory);
  expect((await lstat(join(extracted, linux.artifact))).mode & 0o777).toBe(0o755);
  for (const mismatch of [{ sourceCommit: 'b'.repeat(40) }, { repository: 'another/project' }, { version: '0.4.1' }]) {
    await expect(verifyRelease(options.output, { ...options, ...mismatch })).rejects.toThrow('inventory or source');
  }
  await writeFile(join(options.output, 'unexpected'), 'extra');
  await expect(verifyRelease(options.output, options)).rejects.toThrow('inventory or source');
  await rm(join(options.output, 'unexpected'));
  await writeFile(join(options.output, 'SHA256SUMS'), 'modified checksums');
  await expect(verifyRelease(options.output, options)).rejects.toThrow('checksums differ');
  await writeFile(join(options.output, manifest.artifacts[0].file), 'modified archive');
  await expect(verifyRelease(options.output, options)).rejects.toThrow('hash/size mismatch');
}));

test('requires exactly one correctly named executable in each server/CLI artifact', async () => {
  for (const changed of ['extra', 'renamed']) {
    await fixture(async options => {
      const server = releaseInputs('0.4.0')[0];
      const folder = join(options.input, server.artifact, 'nested');
      if (changed === 'extra') await writeFile(join(folder, 'extra'), 'extra');
      else await rename(join(folder, server.artifact), join(folder, 'wrong-name'));
      await expect(assembleRelease(options)).rejects.toThrow('Invalid executable artifact');
    });
  }
});

test('rejects empty executable payloads', () => fixture(async options => {
  const server = releaseInputs('0.4.0')[0];
  await writeFile(join(options.input, server.artifact, 'nested', server.artifact), '');
  await expect(assembleRelease(options)).rejects.toThrow('Empty or non-regular release file');
}));

test('rejects symlinked executable payloads', () => fixture(async options => {
  const server = releaseInputs('0.4.0')[0];
  const path = join(options.input, server.artifact, 'nested', server.artifact);
  await rm(path);
  await symlink(join(options.directory, 'LICENSE'), path);
  await expect(assembleRelease(options)).rejects.toThrow('Non-regular release input');
}));

test.each([
  ['missing payload', 'Expected one native file', async ({ folder }) => rm(join(folder, 'synthetic.apk'))],
  ['extra payload', 'Unexpected or duplicate native files', async ({ folder }) => writeFile(join(folder, 'unexpected'), 'extra')],
  ['symlink', 'Non-regular release input', async ({ folder, directory }) => {
    await rm(join(folder, 'synthetic.apk'));
    await symlink(join(directory, 'LICENSE'), join(folder, 'synthetic.apk'));
  }],
  ['duplicate payload', 'Expected one native file', async ({ folder }) => {
    await mkdir(join(folder, 'duplicate'));
    await writeFile(join(folder, 'duplicate', 'synthetic.apk'), 'duplicate');
  }],
  ['hash mismatch', 'hash/size mismatch', ({ manifest }) => { manifest.artifacts[0].sha256 = '00'.repeat(32); }],
  ['version mismatch', 'Invalid preview manifest', ({ manifest }) => { manifest.version = '0.3.4'; }],
  ['production status', 'Invalid preview manifest', ({ manifest }) => { manifest.releaseAllowed = true; }],
  ['wrong format', 'Invalid preview manifest', ({ manifest }) => { manifest.artifacts[0].format = 'deb'; }],
  ['unsafe filename', 'Unsafe native artifact filename', ({ manifest }) => { manifest.artifacts[0].file = '../synthetic.apk'; }],
  ['padded filename', 'Unsafe native artifact filename', ({ manifest }) => { manifest.artifacts[0].file += '\n'; }],
  ['missing signer', 'Missing verified Android signer', ({ manifest }) => { delete manifest.artifacts[0].signerCertificateSha256; }],
])('rejects native %s', (_name, message, mutate) => fixture(async options => {
  const folder = join(options.input, 'garcon-native-android-build-only-debug', 'nested');
  const path = join(folder, 'distribution-android.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await mutate({ folder, directory: options.directory, manifest });
  await writeFile(path, JSON.stringify(manifest));
  await expect(assembleRelease(options)).rejects.toThrow(message);
}));

test('rejects mismatched source versions and nonempty output directories', () => fixture(async options => {
  await expect(assembleRelease({ ...options, version: '0.4.1' })).rejects.toThrow('Source archive version');
  await mkdir(options.output);
  await writeFile(join(options.output, 'existing'), 'preserve');
  await expect(assembleRelease(options)).rejects.toThrow('must be empty');
  expect(await readFile(join(options.output, 'existing'), 'utf8')).toBe('preserve');
}));

test('rejects whitespace-padded release identities before packaging', () => fixture(async options => {
  for (const padding of ['\n', '\r\n', ' ', '\u00a0', '\ufeff', '\u2028']) {
    await expect(assembleRelease({ ...options, repository: options.repository + padding }))
      .rejects.toThrow('Invalid release repository');
    await expect(assembleRelease({ ...options, sourceCommit: options.sourceCommit + padding }))
      .rejects.toThrow('Release source must be a full commit SHA');
  }
}));
