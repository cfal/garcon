import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { githubApi, publishedRelease } from './release-github.js';

function command(args) {
  const result = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function imageIndex(raw) {
  const index = JSON.parse(raw);
  if (!Array.isArray(index.manifests)) throw new Error('Expected a multiarch image index');
  const runtime = index.manifests.filter(item => !(item.platform?.os === 'unknown'
    && item.platform?.architecture === 'unknown' && item.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest'));
  if (runtime.length !== 2 || runtime.some(item => item.platform?.os !== 'linux'
    || !/^sha256:[a-f0-9]{64}$/.test(item.digest))
    || JSON.stringify(runtime.map(item => item.platform.architecture).sort()) !== '["amd64","arm64"]') {
    throw new Error('Expected exactly linux/amd64 and linux/arm64 runtime images');
  }
  return {
    digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    platforms: Object.fromEntries(runtime.map(item => [item.platform.architecture, item.digest])),
  };
}

export function registryImage(reference, run = command) {
  const result = run(['docker', 'buildx', 'imagetools', 'inspect', '--raw', reference]);
  if (result.code === 0) return imageIndex(result.stdout);
  if (/manifest unknown|not found/i.test(result.stderr)) return undefined;
  throw new Error(`Registry inspection failed: ${result.stderr}`);
}

export async function promoteRelease(options, { api = githubApi, run = command } = {}) {
  const { image, digest, sourceCommit } = options;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid image digest');
  const current = await publishedRelease(options, api);
  if (current.sourceCommit !== sourceCommit) throw new Error('Release source changed after image verification');
  const candidate = registryImage(`${image}@${digest}`, run);
  if (candidate?.digest !== digest) throw new Error('Verified image digest is unavailable');
  const versionTag = `${image}:${options.tag}`;
  const existing = registryImage(versionTag, run);
  if (existing && existing.digest !== digest) throw new Error('Refusing to overwrite a different version image');
  const promote = tag => {
    const result = run(['docker', 'buildx', 'imagetools', 'create', '--tag', tag, `${image}@${digest}`]);
    if (result.code !== 0) throw new Error(`Image promotion failed: ${result.stderr}`);
    if (registryImage(tag, run)?.digest !== digest) throw new Error('Promoted image digest mismatch');
  };
  if (!existing) promote(versionTag);
  // Rechecks publication state immediately before the mutable latest alias.
  const latestSource = await publishedRelease(options, api);
  if (latestSource.sourceCommit !== sourceCommit) throw new Error('Release tag moved during promotion');
  if (latestSource.release.prerelease) return;
  const latest = await api(`repos/${options.repository}/releases/latest`);
  if (String(latest.id) === String(options.releaseId) && latest.draft === false && latest.prerelease === false) {
    promote(`${image}:latest`);
  }
}

if (import.meta.main) {
  const [intent, ...extra] = process.argv.slice(2);
  if (extra.length || !['find', 'resolve', 'promote'].includes(intent)) throw new Error('Usage: bun scripts/docker-release.js <find|resolve|promote>');
  const image = process.env.IMAGE;
  if (intent === 'find') {
    const existing = registryImage(`${image}:sha-${process.env.SOURCE_SHA}`);
    let output = `exists=${Boolean(existing)}\n`;
    if (existing) output += `digest=${existing.digest}\n`;
    await appendFile(process.env.GITHUB_OUTPUT, output);
  } else if (intent === 'resolve') {
    const digest = process.env.EXISTING_DIGEST || process.env.BUILT_DIGEST;
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('Invalid publication digest');
    if (registryImage(`${image}@${digest}`)?.digest !== digest) throw new Error('Published image digest mismatch');
    await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  } else {
    await promoteRelease({ image, digest: process.env.DIGEST, sourceCommit: process.env.SOURCE_SHA,
      repository: process.env.GITHUB_REPOSITORY, releaseId: process.env.RELEASE_ID, tag: process.env.RELEASE_TAG });
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `Verified ${image}:${process.env.RELEASE_TAG} at ${process.env.DIGEST}.\n`);
  }
}
