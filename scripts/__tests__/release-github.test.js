import { expect, test } from 'bun:test';
import { assertNewRelease, publishedRelease, resolveTag } from '../release-github.js';

const identity = { repository: 'synthetic/project', tag: 'v0.4.0', sourceCommit: 'a'.repeat(40), releaseId: 7 };
function fixture(overrides = {}) {
  const routes = {
    'git/ref/tags/v0.4.0': { object: { type: 'tag', sha: 'b'.repeat(40) } },
    [`git/tags/${'b'.repeat(40)}`]: { object: { type: 'commit', sha: identity.sourceCommit } },
    'releases?per_page=100&page=1': [],
    'releases/7': { id: 7, tag_name: 'v0.4.0', draft: false, prerelease: false, published_at: '2026-01-01',
      assets: [{ id: 9, name: 'release-manifest.json' }] },
    'releases/assets/9': { schemaVersion: 1, ...identity, version: '0.4.0' },
    ...overrides,
  };
  return async path => {
    const key = path.replace('repos/synthetic/project/', '');
    if (!Object.hasOwn(routes, key)) throw new Error(`Unexpected API request: ${path}`);
    return routes[key];
  };
}

test('annotated and lightweight tags resolve to the captured commit', async () => {
  expect(await resolveTag(identity.repository, identity.tag, fixture())).toBe(identity.sourceCommit);
  expect(await resolveTag(identity.repository, identity.tag, fixture({
    'git/ref/tags/v0.4.0': { object: { type: 'commit', sha: identity.sourceCommit } },
  }))).toBe(identity.sourceCommit);
  await expect(assertNewRelease(identity, fixture())).resolves.toBeUndefined();
  await expect(publishedRelease(identity, fixture())).resolves.toMatchObject({ sourceCommit: identity.sourceCommit, version: '0.4.0' });
});

test('draft guard paginates and rejects every existing release, moved tags and API failures', async () => {
  for (const draft of [true, false]) {
    await expect(assertNewRelease(identity, fixture({
      'releases?per_page=100&page=1': Array.from({ length: 100 }, () => ({ tag_name: 'v0.3.0' })),
      'releases?per_page=100&page=2': [{ tag_name: identity.tag, draft }],
    }))).rejects.toThrow('already exists');
  }
  await expect(assertNewRelease({ ...identity, sourceCommit: 'c'.repeat(40) }, fixture())).rejects.toThrow('moved');
  await expect(assertNewRelease(identity, async () => { throw new Error('API denied'); })).rejects.toThrow('API denied');
  await expect(resolveTag(identity.repository, identity.tag, fixture({
    'git/ref/tags/v0.4.0': { object: { type: 'tree', sha: identity.sourceCommit } },
  }))).rejects.toThrow('commit');
});

test('tag validation retains prefix and numeric-version diagnostics without making API requests', async () => {
  const unexpectedRequest = () => { throw new Error('Unexpected API request'); };
  for (const tag of [undefined, null, 4, '', '0.4.0']) {
    await expect(resolveTag(identity.repository, tag, unexpectedRequest)).rejects.toThrow('Expected a numeric release tag');
  }
  for (const tag of ['v', 'v0.4.0-rc.1', 'v0.4.0\n', 'v0.4.0$(id)']) {
    await expect(resolveTag(identity.repository, tag, unexpectedRequest)).rejects.toThrow('numeric MAJOR.MINOR.PATCH');
  }
});

test('Docker source requires a published release whose manifest agrees with its live tag', async () => {
  for (const difference of [{ draft: true }, { id: 8 }, { published_at: null }, { tag_name: 'v0.4.1' }, { assets: [] }]) {
    const original = await fixture()('repos/synthetic/project/releases/7');
    await expect(publishedRelease(identity, fixture({ 'releases/7': { ...original, ...difference } }))).rejects.toThrow();
  }
  for (const difference of [{ sourceCommit: 'c'.repeat(40) }, { version: '0.4.1' }, { repository: 'another/project' }]) {
    const original = await fixture()('repos/synthetic/project/releases/assets/9');
    await expect(publishedRelease(identity, fixture({ 'releases/assets/9': { ...original, ...difference } })))
      .rejects.toThrow('differs');
  }
});
