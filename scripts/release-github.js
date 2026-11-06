import { appendFile } from 'node:fs/promises';
import { readReleaseVersion, releaseTag } from './release-version.js';

export function githubApi(endpoint, downloadAsset = false) {
  const result = Bun.spawnSync(['gh', 'api', endpoint, ...(downloadAsset ? ['-H', 'Accept: application/octet-stream'] : [])],
    { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`GitHub API failed for ${endpoint}: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString());
}

function validateTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) {
    throw new Error('Expected a numeric release tag');
  }
  releaseTag(tag.slice(1));
}

export async function resolveTag(repository, tag, api = githubApi) {
  validateTag(tag);
  let { object } = await api(`repos/${repository}/git/ref/tags/${tag}`);
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    ({ object } = await api(`repos/${repository}/git/tags/${object.sha}`));
  }
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) throw new Error('Tag does not resolve to a commit');
  return object.sha;
}

export async function assertNewRelease({ repository, tag, sourceCommit }, api = githubApi) {
  if (await resolveTag(repository, tag, api) !== sourceCommit) throw new Error('Release tag moved from the built source');
  for (let page = 1; ; page++) {
    const releases = await api(`repos/${repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Invalid releases response');
    if (releases.some(release => release.tag_name === tag)) throw new Error('Release already exists; never overwrite drafts or published assets');
    if (releases.length < 100) return;
  }
}

export async function publishedRelease({ repository, releaseId, tag }, api = githubApi) {
  validateTag(tag);
  if (!/^[1-9]\d*$/.test(String(releaseId))) throw new Error('Invalid release ID');
  const release = await api(`repos/${repository}/releases/${releaseId}`);
  if (String(release.id) !== String(releaseId) || release.tag_name !== tag
    || release.draft !== false || !release.published_at) throw new Error('Release is not currently published with the expected tag');
  const sourceCommit = await resolveTag(repository, tag, api);
  const assets = release.assets.filter(asset => asset.name === 'release-manifest.json');
  if (assets.length !== 1) throw new Error('Expected one release manifest');
  const manifest = await api(`repos/${repository}/releases/assets/${assets[0].id}`, true);
  if (manifest.schemaVersion !== 1 || manifest.repository !== repository || manifest.tag !== tag
    || manifest.version !== tag.slice(1) || manifest.sourceCommit !== sourceCommit) {
    throw new Error('Published release manifest differs from live tag/source');
  }
  return { sourceCommit, version: manifest.version, release };
}

if (import.meta.main) {
  const [intent, ...extra] = process.argv.slice(2);
  if (extra.length || !['source', 'draft-guard'].includes(intent)) throw new Error('Usage: bun scripts/release-github.js <source|draft-guard>');
  const repository = process.env.GITHUB_REPOSITORY;
  if (intent === 'draft-guard') {
    await readReleaseVersion(undefined, process.env.GITHUB_REF_NAME);
    await assertNewRelease({ repository, tag: process.env.GITHUB_REF_NAME, sourceCommit: process.env.GITHUB_SHA });
  } else {
    let sourceCommit = process.env.GITHUB_SHA;
    if (process.env.GITHUB_EVENT_NAME === 'release') {
      const source = await publishedRelease({ repository, releaseId: process.env.RELEASE_ID, tag: process.env.RELEASE_TAG });
      sourceCommit = source.sourceCommit;
    }
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Invalid source commit');
    await appendFile(process.env.GITHUB_OUTPUT, `sha=${sourceCommit}\nimage=ghcr.io/${repository.toLowerCase()}\n`);
  }
}
