import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { inspectArtifact, targets } from '../native/scripts/distribution.js';
import { readReleaseVersion, releaseTag } from './release-version.js';

const root = resolve(import.meta.dir, '..');
const nativePlatforms = {
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'x86_64-pc-windows-msvc': 'windows-x64',
  'aarch64-apple-darwin': 'macos-arm64',
  'x86_64-apple-darwin': 'macos-x64',
  android: 'android-build-only-universal-debug',
  'ios-simulator': 'ios-simulator',
};

export function releaseInputs(version) {
  const tag = releaseTag(version);
  return [
    ...[`garcon-${tag}-linux-x64`, `garcon-${tag}-windows-x64.exe`, `garcon-cli-${tag}-linux-x64`]
      .map(name => ({ artifact: name, archive: `${name}.zip`, kind: name.startsWith('garcon-cli-') ? 'cli' : 'server' })),
    ...Object.entries(nativePlatforms).map(([target, platform]) => ({
      artifact: target === 'android' ? 'garcon-native-android-build-only-debug' : `garcon-native-${target}`,
      archive: `garcon-native-preview-${tag}-${platform}.zip`, kind: 'native-preview', target,
    })),
  ];
}

function command(args, cwd) {
  const result = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

async function filesUnder(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error(`Expected artifact directory: ${directory}`);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Non-regular release input: ${path}`);
  }
  return files;
}

async function regularFileInfo(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Empty or non-regular release file: ${path}`);
  return info;
}

async function record(path) {
  const info = await regularFileInfo(path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { file: basename(path), bytes: info.size, sha256: hash.digest('hex') };
}

function sameNames(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function checksumText(files) {
  return [...files]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(file => `${file.sha256}  ${file.file}\n`)
    .join('');
}

async function nativeFiles(input, files, version) {
  const manifestName = `distribution-${input.target}.json`;
  const manifests = files.filter(path => basename(path) === manifestName);
  if (manifests.length !== 1) throw new Error(`Expected one ${manifestName}`);
  const manifest = JSON.parse(await readFile(manifests[0], 'utf8'));
  const target = targets[input.target];
  const expectedSigning = input.target === 'android' ? 'ephemeral-debug-key-not-stable' : 'unsigned-not-distribution-verified';
  if (manifest.schemaVersion !== 1 || manifest.target !== input.target || manifest.version !== version
    || manifest.distribution !== 'preview-only' || manifest.releaseAllowed !== false
    || manifest.runtimeResult !== 'not-attested-by-artifact-validation'
    || manifest.runtimeGate !== target.runtime
    || !Array.isArray(manifest.releaseBlockers) || !sameNames(manifest.releaseBlockers, target.blockers)
    || manifest.signing !== expectedSigning
    || !Array.isArray(manifest.artifacts)
    || !sameNames(manifest.artifacts.map(artifact => artifact.format), target.formats)) {
    throw new Error(`Invalid preview manifest: ${manifestName}`);
  }
  const selected = [manifests[0]];
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(artifact.file)
      || [manifestName, 'LICENSE'].includes(artifact.file)) {
      throw new Error(`Unsafe native artifact filename: ${artifact.file}`);
    }
    const matches = files.filter(path => basename(path) === artifact.file);
    if (matches.length !== 1) throw new Error(`Expected one native file: ${artifact.file}`);
    const actual = await inspectArtifact(matches[0], artifact.format);
    if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256) {
      throw new Error(`Native artifact hash/size mismatch: ${artifact.file}`);
    }
    if (input.target === 'android' && !/^[a-f0-9]{64}$/.test(artifact.signerCertificateSha256 ?? '')) {
      throw new Error('Missing verified Android signer certificate');
    }
    selected.push(matches[0]);
  }
  if (!sameNames(files, selected) || new Set(selected.map(path => basename(path))).size !== selected.length) {
    throw new Error(`Unexpected or duplicate native files: ${input.artifact}`);
  }
  return selected;
}

export async function assembleRelease({ input, output, version, sourceCommit, repository, directory = root }) {
  input = resolve(input);
  output = resolve(output);
  const tag = releaseTag(version);
  if (typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('Release source must be a full commit SHA');
  }
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid release repository');
  }
  const sourcePackage = JSON.parse(command(['git', 'show', `${sourceCommit}:package.json`], directory));
  if (sourcePackage.version !== version) throw new Error('Source archive version differs from release version');
  const inputs = releaseInputs(version);
  if (!sameNames(await readdir(input), inputs.map(value => value.artifact))) {
    throw new Error('Release inputs do not match the expected nine CI artifacts');
  }
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error('Release output directory must be empty');
  const staging = await mkdtemp(join(output, '.staging-'));
  const artifacts = [];
  try {
    for (const entry of inputs) {
      const files = await filesUnder(join(input, entry.artifact));
      const selected = entry.target ? await nativeFiles(entry, files, version) : files;
      if (!entry.target && (files.length !== 1 || basename(files[0]) !== entry.artifact)) {
        throw new Error(`Invalid executable artifact: ${entry.artifact}`);
      }
      const work = join(staging, entry.artifact);
      await mkdir(work);
      for (const path of selected) {
        const destination = join(work, basename(path));
        await regularFileInfo(path);
        await copyFile(path, destination);
        if (!entry.target) await chmod(destination, 0o755);
      }
      await copyFile(join(directory, 'LICENSE'), join(work, 'LICENSE'));
      const archive = join(output, entry.archive);
      command(['zip', '-q', '-X', ...(entry.target ? ['-0'] : []), archive,
        ...selected.map(path => basename(path)).sort(), 'LICENSE'], work);
      artifacts.push({ ...await record(archive), kind: entry.kind, ...(entry.target ? { target: entry.target } : {}) });
    }
    const sourceArchive = join(output, `garcon-${tag}-source.tar.gz`);
    command(['git', 'archive', '--format=tar.gz', `--prefix=garcon-${tag}/`, `--output=${sourceArchive}`, sourceCommit], directory);
    artifacts.push({ ...await record(sourceArchive), kind: 'source' });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const manifest = { schemaVersion: 1, version, tag, repository, sourceCommit, artifacts };
  const manifestPath = join(output, 'release-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = [...artifacts, await record(manifestPath)];
  await writeFile(join(output, 'SHA256SUMS'), checksumText(checksums));
  if (!sameNames(await readdir(output), [...checksums.map(file => file.file), 'SHA256SUMS'])) {
    throw new Error('Unexpected final release inventory');
  }
  return manifest;
}

export async function verifyRelease(output, { version, repository, sourceCommit }) {
  const manifestPath = join(output, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expected = [...releaseInputs(version).map(input => input.archive), `garcon-${releaseTag(version)}-source.tar.gz`];
  if (manifest.schemaVersion !== 1 || manifest.version !== version || manifest.tag !== releaseTag(version)
    || manifest.repository !== repository || manifest.sourceCommit !== sourceCommit
    || !Array.isArray(manifest.artifacts) || !sameNames(manifest.artifacts.map(file => file.file), expected)
    || !sameNames(await readdir(output), [...expected, 'release-manifest.json', 'SHA256SUMS'])) {
    throw new Error('Invalid final release inventory or source identity');
  }
  for (const artifact of manifest.artifacts) {
    const actual = await record(join(output, artifact.file));
    if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) {
      throw new Error(`Final release hash/size mismatch: ${artifact.file}`);
    }
  }
  const checksums = [...manifest.artifacts, await record(manifestPath)];
  if (await readFile(join(output, 'SHA256SUMS'), 'utf8') !== checksumText(checksums)) {
    throw new Error('Final release checksums differ from verified inventory');
  }
  return manifest;
}

if (import.meta.main) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw new Error('Usage: bun scripts/release-assets.js <input|verify> <output>');
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  const identity = {
    version: await readReleaseVersion(root, tag),
    sourceCommit: process.env.GITHUB_SHA,
    repository: process.env.GITHUB_REPOSITORY,
  };
  let manifest;
  if (input === 'verify') {
    manifest = await verifyRelease(resolve(output), identity);
  } else {
    manifest = await assembleRelease({ input, output, ...identity });
  }
  console.log(JSON.stringify(manifest, null, 2));
}
