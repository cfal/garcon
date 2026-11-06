import { expect, test } from 'bun:test';
import { imageIndex, promoteRelease, registryImage } from '../docker-release.js';

const descriptors = ['amd64', 'arm64'].map((architecture, index) => ({
  digest: `sha256:${String(index).repeat(64)}`, platform: { os: 'linux', architecture },
}));
const raw = JSON.stringify({ manifests: descriptors });
const digest = imageIndex(raw).digest;
const options = { image: 'ghcr.io/synthetic/project', digest, sourceCommit: 'a'.repeat(40),
  repository: 'synthetic/project', releaseId: 7, tag: 'v0.4.0' };

function fixture({ prerelease = false, latest = 7, existing, failLatest = false, moved = false } = {}) {
  const writes = [];
  const images = new Map([[`${options.image}@${digest}`, raw]]);
  if (existing) images.set(`${options.image}:v0.4.0`, existing);
  let publicationReads = 0;
  const api = async endpoint => {
    if (endpoint.endsWith('/releases/7')) {
      publicationReads++;
      return { id: 7, tag_name: options.tag, draft: false, published_at: '2026-01-01', prerelease,
        assets: [{ id: 9, name: 'release-manifest.json' }] };
    }
    if (endpoint.endsWith('/git/ref/tags/v0.4.0')) return { object: { type: 'commit',
      sha: moved && publicationReads > 1 ? 'c'.repeat(40) : options.sourceCommit } };
    if (endpoint.endsWith('/releases/assets/9')) return { schemaVersion: 1, ...options, version: '0.4.0' };
    if (endpoint.endsWith('/releases/latest')) {
      if (failLatest) throw new Error('API denied');
      return { id: latest, draft: false, prerelease: false };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const run = args => {
    if (args[3] === 'inspect') {
      const content = images.get(args.at(-1));
      return content ? { code: 0, stdout: content, stderr: '' } : { code: 1, stderr: 'manifest unknown' };
    }
    if (args[3] === 'create') {
      const tag = args[5];
      expect(args[6]).toBe(`${options.image}@${digest}`);
      writes.push(tag);
      images.set(tag, raw);
      return { code: 0 };
    }
    throw new Error(`Unexpected command ${args}`);
  };
  return { api, run, writes, images };
}

test('requires exactly two runtime platforms, permitting only recognized attestation descriptors', () => {
  expect(imageIndex(raw).platforms.amd64).toBe(descriptors[0].digest);
  expect(imageIndex(JSON.stringify({ manifests: [...descriptors, { platform: { os: 'unknown', architecture: 'unknown' },
    annotations: { 'vnd.docker.reference.type': 'attestation-manifest' } }] })).platforms).toEqual(imageIndex(raw).platforms);
  for (const manifests of [[], [descriptors[0]], [descriptors[0], descriptors[0]], [...descriptors, descriptors[0]],
    [...descriptors, { platform: { os: 'windows', architecture: 'amd64' } }],
    [descriptors[0], { ...descriptors[1], platform: { os: 'linux', architecture: 's390x' } }],
    [descriptors[0], { digest: descriptors[1].digest }],
    [descriptors[0], { ...descriptors[1], digest: 'bad' }]]) {
    expect(() => imageIndex(JSON.stringify({ manifests }))).toThrow('Expected exactly linux/amd64 and linux/arm64 runtime images');
  }
  expect(registryImage('absent', () => ({ code: 1, stderr: 'manifest unknown' }))).toBeUndefined();
  expect(() => registryImage('private', () => ({ code: 1, stderr: 'unauthorized' }))).toThrow('inspection failed');
});

test('promotes exact version and current stable latest; retries preserve existing version bytes', async () => {
  const fake = fixture();
  await promoteRelease(options, fake);
  expect(fake.writes).toEqual([`${options.image}:v0.4.0`, `${options.image}:latest`]);
  fake.writes.length = 0;
  await promoteRelease(options, fake);
  expect(fake.writes).toEqual([`${options.image}:latest`]);
});

test('prereleases and older releases never advance latest', async () => {
  for (const configuration of [{ prerelease: true }, { latest: 8 }]) {
    const fake = fixture(configuration);
    await promoteRelease(options, fake);
    expect(fake.writes).toEqual([`${options.image}:v0.4.0`]);
  }
});

test('version conflicts, source changes, and API failures cannot silently advance aliases', async () => {
  const conflict = fixture({ existing: JSON.stringify({ manifests: descriptors, changed: true }) });
  await expect(promoteRelease(options, conflict)).rejects.toThrow('overwrite');
  expect(conflict.writes).toEqual([]);
  const wrongSource = fixture();
  await expect(promoteRelease({ ...options, sourceCommit: 'b'.repeat(40) }, wrongSource)).rejects.toThrow('source changed');
  expect(wrongSource.writes).toEqual([]);
  for (const configuration of [{ moved: true }, { prerelease: true, moved: true }, { failLatest: true }]) {
    const fake = fixture(configuration);
    await expect(promoteRelease(options, fake)).rejects.toThrow();
    expect(fake.writes).toEqual([`${options.image}:v0.4.0`]);
  }
});
