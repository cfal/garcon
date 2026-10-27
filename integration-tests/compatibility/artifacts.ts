import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_ARTIFACT, type SourceArtifact } from '../support/source-artifact.js';

export interface Baseline {
  readonly sourceSha: string;
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly lockfiles: Readonly<Record<string, string>>;
  readonly runtime: { readonly version: string; readonly archiveUrl: string; readonly archiveSha256: string };
}

export interface BaselineManifest {
  readonly core: 1;
  readonly stage: 'bootstrap' | 'cross-build';
  readonly bootstrapPackageVersion?: string;
  readonly baselines: readonly Baseline[];
}

export interface CompatibilityArtifact extends SourceArtifact { readonly sourceSha: string }

export function validateManifest(value: unknown, packageVersion: string): BaselineManifest {
  assert(value && typeof value === 'object');
  const manifest = value as BaselineManifest;
  assert.equal(manifest.core, 1);
  assert(Array.isArray(manifest.baselines));
  if (manifest.stage === 'bootstrap') {
    assert.equal(manifest.bootstrapPackageVersion, packageVersion, 'Publish and pin the core-1 baseline before the next release');
    assert.equal(manifest.baselines.length, 0, 'Bootstrap cannot silently ignore a pinned baseline');
  } else {
    assert.equal(manifest.stage, 'cross-build');
    assert(manifest.baselines.length > 0, 'Cross-build acceptance requires an immutable baseline');
    for (const baseline of manifest.baselines) {
      assert.match(baseline.sourceSha, /^[a-f0-9]{40}$/);
      assert.match(baseline.runtime.version, /^\d+\.\d+\.\d+$/);
      for (const archive of [baseline, baseline.runtime]) {
        assert.match(archive.archiveSha256, /^[a-f0-9]{64}$/);
        assert.equal(new URL(archive.archiveUrl).protocol, 'https:');
      }
      assert.deepEqual(Object.keys(baseline.lockfiles).sort(), ['bun.lock', 'integration-tests/bun.lock']);
      for (const digest of Object.values(baseline.lockfiles)) assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
    }
  }
  return manifest;
}

export async function commandOutput(cmd: readonly string[], cwd = CURRENT_ARTIFACT.repoRoot): Promise<string> {
  const child = Bun.spawn([...cmd], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, `${cmd[0]} ${cmd[1]} failed: ${stderr}`);
  return stdout.trim();
}

export function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export async function downloadArchive(url: string, destination: string, digest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  assert(response.ok, `Baseline download failed: ${response.status}`);
  await Bun.write(destination, response);
  assert.equal(sha256(await readFile(destination)), digest, 'Immutable artifact digest mismatch');
}

export async function prepareArtifacts(input?: unknown): Promise<{
  current: CompatibilityArtifact;
  baselines: readonly CompatibilityArtifact[];
  stage: BaselineManifest['stage'];
  dispose(): Promise<void>;
}> {
  const current = { ...CURRENT_ARTIFACT, sourceSha: await commandOutput(['git', 'rev-parse', 'HEAD']) };
  const packageVersion = (await Bun.file(join(current.repoRoot, 'package.json')).json()).version;
  const manifest = validateManifest(input ?? await Bun.file(new URL('./baselines.json', import.meta.url)).json(), packageVersion);
  const scratch = join(homedir(), 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'garcon-compatibility-artifacts-'));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const baselines: CompatibilityArtifact[] = [];
    for (const baseline of manifest.baselines) {
      assert.notEqual(baseline.sourceSha, current.sourceSha, 'A mixed-build pair must have distinct source revisions');
      const directory = join(root, baseline.sourceSha);
      const repoRoot = join(directory, 'source');
      const runtimeRoot = join(directory, 'runtime');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(runtimeRoot, { recursive: true });
      const sourceArchive = join(directory, 'source.tar.gz');
      const runtimeArchive = join(directory, 'runtime.zip');
      await downloadArchive(baseline.archiveUrl, sourceArchive, baseline.archiveSha256);
      await downloadArchive(baseline.runtime.archiveUrl, runtimeArchive, baseline.runtime.archiveSha256);
      await commandOutput(['tar', '-xzf', sourceArchive, '--strip-components=1', '-C', repoRoot]);
      await commandOutput(['unzip', '-q', runtimeArchive, '-d', runtimeRoot]);
      const executables = [...new Bun.Glob('*/bun').scanSync({ cwd: runtimeRoot, absolute: true })];
      assert.equal(executables.length, 1);
      const bunExecutable = executables[0]!;
      assert.equal(await commandOutput([bunExecutable, '--version']), baseline.runtime.version);
      const metadata = await Bun.file(join(repoRoot, 'compatibility-artifact.json')).json();
      assert.equal(metadata.sourceSha, baseline.sourceSha);
      assert.equal(metadata.core, 1);
      assert.equal(metadata.bunVersion, baseline.runtime.version);
      for (const [file, digest] of Object.entries(baseline.lockfiles)) {
        assert.equal(sha256(await readFile(join(repoRoot, file))), digest, `Baseline ${file} changed`);
      }
      // Each artifact owns its installation and generated outputs; only Bun's download cache is shared.
      await commandOutput([bunExecutable, 'install', '--frozen-lockfile'], repoRoot);
      await commandOutput([bunExecutable, 'install', '--frozen-lockfile'], join(repoRoot, 'integration-tests'));
      await commandOutput([bunExecutable, 'run', '--cwd', 'web', 'i18n:compile'], repoRoot);
      baselines.push({ repoRoot, bunExecutable, sourceSha: baseline.sourceSha });
    }
    console.log(JSON.stringify({ stage: manifest.stage, current: current.sourceSha, baselines: baselines.map(item => item.sourceSha),
      optionalContractEvidence: 'not-applicable: no optional production contracts' }));
    return { current, baselines, stage: manifest.stage, dispose };
  } catch (error) { await dispose(); throw error; }
}
