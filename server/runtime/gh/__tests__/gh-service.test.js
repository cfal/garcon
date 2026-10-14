import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGhOperations } from '../gh-service.js';

let root;
let originalPath;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-gh-pages-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.copyFile(new URL('../../../remote/__tests__/fixtures/fake-gh.js', import.meta.url), path.join(bin, 'gh'));
  await fs.chmod(path.join(bin, 'gh'), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
});
afterEach(async () => {
  process.env.PATH = originalPath;
  await fs.rm(root, { recursive: true, force: true });
});

it('lists open pull requests with the inputs review selection needs', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({
    label: 'synthetic', login: 'viewer-one',
    pulls: [
      { number: 3, reviewRequests: ['viewer-one'], labels: ['bug'], checks: 'SUCCESS' },
      { number: 4, author: { login: 'author-two', __typename: 'Bot' }, authorAssociation: 'NONE', isCrossRepository: true, teamReviewRequested: true },
      { number: 5, state: 'CLOSED' },
    ],
  }));
  const list = await createGhOperations(root).listPullRequests({ projectPath: root });
  expect(list.repo).toEqual({ nameWithOwner: 'synthetic/repository', url: 'https://git.example.invalid/synthetic/repository' });
  expect(list.viewerLogin).toBe('viewer-one');
  expect(list.pulls).toMatchObject([
    { number: 3, reviewRequest: 'me', authoredByViewer: true, authorAssociation: 'member', labels: ['bug'], checksState: 'passing', headRefOid: 'a'.repeat(40) },
    { number: 4, reviewRequest: 'team', authoredByViewer: false, authorIsBot: true, authorAssociation: 'none', isCrossRepository: true },
  ]);
});

it('posts a comment, finds it by marker, and minimizes it', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', pulls: [{ number: 3, headRefOid: 'c'.repeat(40) }] }));
  const gh = createGhOperations(root);
  // Longer than one argument may be, so it can only arrive through standard input.
  const body = `${'review line\n'.repeat(5_000)}\n<!-- garcon-review synthetic/repository#3 ${'c'.repeat(40)} -->`;
  const created = await gh.createPullRequestComment({ projectPath: root, number: 3, body });
  expect(created.url).toContain('/pull/3#issuecomment-');

  const target = await gh.getPullRequestReviewTarget({ projectPath: root, number: 3, marker: 'garcon-review synthetic/repository#3 ' });
  expect(target).toMatchObject({ number: 3, state: 'open', headRefOid: 'c'.repeat(40) });
  expect(target.markedComments).toEqual([
    { id: created.id, url: created.url, marker: `<!-- garcon-review synthetic/repository#3 ${'c'.repeat(40)} -->`, isMinimized: false },
  ]);

  expect(await gh.minimizePullRequestComment({ projectPath: root, commentId: created.id })).toEqual({ minimized: true });
  const after = await gh.getPullRequestReviewTarget({ projectPath: root, number: 3, marker: 'garcon-review ' });
  expect(after.markedComments.map((comment) => comment.isMinimized)).toEqual([true]);
});

it('reports a pull request that does not exist', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic' }));
  await expect(createGhOperations(root).getPullRequestReviewTarget({ projectPath: root, number: 99, marker: 'garcon-review ' }))
    .rejects.toThrow(/could not resolve to a pullrequest/i);
});

it('reads 101 open pull requests and all policy connections', async () => {
  const labels = Array.from({ length: 101 }, (_, index) => `label-${index}`);
  const reviewers = Array.from({ length: 101 }, (_, index) => `reviewer-${index}`);
  reviewers[100] = 'viewer';
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({
    label: 'synthetic', login: 'viewer',
    pulls: Array.from({ length: 101 }, (_, index) => ({ number: index + 1, labels: index === 100 ? labels : [], reviewRequests: index === 100 ? reviewers : ['viewer'] })),
  }));
  const list = await createGhOperations(root).listPullRequests({ projectPath: root });
  expect(list.pulls).toHaveLength(101);
  expect(list.pulls[100]).toMatchObject({ number: 101, labels, reviewRequest: 'me' });
}, 30_000);

it('finds an idempotency marker outside the newest 100 comments', async () => {
  const marker = `<!-- garcon-review synthetic/repository#3 ${'a'.repeat(40)} -->`;
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({
    label: 'synthetic', pulls: [{ number: 3 }],
    comments: Array.from({ length: 101 }, (_, index) => ({ id: `comment-${index}`, number: 3, body: index === 0 ? marker : 'Unrelated' })),
  }));
  const target = await createGhOperations(root).getPullRequestReviewTarget({ projectPath: root, number: 3, marker: 'garcon-review synthetic/repository#3 ' });
  expect(target.markedComments).toMatchObject([{ id: 'comment-0', marker }]);
});

const first = { id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'first page' };
it('rejects incomplete connections rather than returning a partial list or posting target', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', incompleteConnection: true }));
  const gh = createGhOperations(root);
  await expect(gh.listPullRequests({ projectPath: root })).rejects.toThrow('incomplete connection');
  await expect(gh.getPullRequestReviewTarget({ projectPath: root, number: 1, marker: 'garcon-review ' })).rejects.toThrow('incomplete connection');
});

const second = { id: 2, path: 'example.txt', line: 2, side: 'RIGHT', body: 'second page' };
for (const [label, commentPages, bodies] of [
  ['no pages', [], []],
  ['empty page', [[]], []],
  ['single page', [[first]], ['first page']],
  ['multiple pages', [[first], [second]], ['first page', 'second page']],
]) {
  it(`retains review comments with ${label}`, async () => {
    await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', commentPages }));
    const detail = await createGhOperations(root).getPullRequest({ projectPath: root, number: 1 });
    expect(detail.threads.flatMap(thread => thread.comments.map(comment => comment.body))).toEqual(bodies);
  });
}
