import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watch } from 'node:fs';
import { createGhOperations } from '../gh-service.js';

const repository = {host: "git.example.invalid", nameWithOwner: "synthetic/repository"};
const expectedPull = { state: "open", headRefOid: "a".repeat(40) };
const commits = { baseRefOid: 'e'.repeat(40), headRefOid: 'a'.repeat(40) };
const actor = {id: "actor:synthetic", login: "synthetic"};
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

for (const change of [{ state: 'CLOSED' }, { state: 'MERGED' }, { headRefOid: 'b'.repeat(40) }]) {
  it(`rechecks the pull request after a held posting-actor preflight: ${JSON.stringify(change)}`, async () => {
    const config = { label: 'synthetic', holdPostingActor: true, pulls: [{ number: 1 }] };
    const fixture = path.join(root, 'gh-fixture.json');
    await fs.writeFile(fixture, JSON.stringify(config));
    const started = Promise.withResolvers();
    const watcher = watch(root, (_event, file) => { if (file === 'gh-actor-started') started.resolve(); });
    const posting = createGhOperations(root).createPullRequestComment({
      projectPath: root, repository, actor, number: 1, body: 'Synthetic review', expected: { state: 'open', headRefOid: 'a'.repeat(40) },
    });
    const outcome = posting.then(result => result, error => error);
    try {
      await started.promise;
      await fs.writeFile(fixture, JSON.stringify({ ...config, pulls: [{ number: 1, ...change }] }));
      await fs.writeFile(path.join(root, 'gh-actor-release'), 'released');
      expect(await outcome).toMatchObject({ code: 'GH_STALE_PULL_REQUEST' });
      expect(await Bun.file(path.join(root, 'gh-comments.json')).exists()).toBe(false);
    } finally {
      watcher.close();
      await fs.writeFile(path.join(root, 'gh-actor-release'), 'released');
      await outcome;
    }
  });
}

it('reports an unknown outcome when GitHub accepted the comment before a network failure', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({
    label: 'synthetic', commentFailureAfterWrite: 'Post: connection reset by peer',
  }));
  await expect(createGhOperations(root).createPullRequestComment({
    projectPath: root, repository, actor, number: 1, body: 'Synthetic review', expected: { state: 'open', headRefOid: 'a'.repeat(40) },
  })).rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
  expect(JSON.parse(await fs.readFile(path.join(root, 'gh-comments.json'), 'utf8'))).toMatchObject([{ body: 'Synthetic review' }]);
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
  const created = await gh.createPullRequestComment({ projectPath: root, repository, actor, expected: { ...expectedPull, headRefOid: "c".repeat(40) }, number: 3, body });
  expect(created.url).toContain('/pull/3#issuecomment-');

  const target = await gh.getPullRequestReviewTarget({ projectPath: root, repository, actor, number: 3, marker: 'garcon-review synthetic/repository#3 ' });
  expect(target).toMatchObject({ number: 3, state: 'open', headRefOid: 'c'.repeat(40) });
  expect(target.markedComments).toEqual([
    { id: created.id, url: created.url, marker: `<!-- garcon-review synthetic/repository#3 ${'c'.repeat(40)} -->`, isMinimized: false, author: actor },
  ]);

  expect(await gh.minimizePullRequestComment({ projectPath: root, repository, actor, commentId: created.id })).toEqual({ minimized: true });
  await gh.listPullRequests({ projectPath: root, repository });
  const status = await gh.getPullRequestStatus({ projectPath: root, repository, number: 3 });
  await gh.getPullRequestDiff({ projectPath: root, repository, number: 3, commits: { baseRefOid: status.baseRefOid, headRefOid: status.headRefOid } });
  await gh.getPullRequestReviewThreads({ projectPath: root, repository, number: 3 });
  const after = await gh.getPullRequestReviewTarget({ projectPath: root, repository, actor, number: 3, marker: 'garcon-review ' });
  expect(after.markedComments.map((comment) => comment.isMinimized)).toEqual([true]);
  const calls = (await fs.readFile(path.join(root, 'gh-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const args of calls) {
    expect(args.join(' ')).not.toContain('{owner}');
    expect(args.join(' ')).not.toContain('{repo}');
    if (args[0] === 'api') expect(args[args.indexOf('--hostname') + 1]).toBe(repository.host);
    if (args[0] === 'pr') expect(args[args.indexOf('--repo') + 1]).toBe(`${repository.host}/${repository.nameWithOwner}`);
  }
});

it('reports a pull request that does not exist', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic' }));
  await expect(createGhOperations(root).getPullRequestReviewTarget({ projectPath: root, repository, actor, number: 99, marker: 'garcon-review ' }))
    .rejects.toThrow(/could not resolve to a pullrequest/i);
});

for (const [label, commentResponse] of [
  ['malformed JSON', '{'], ['missing identity', '{}'], ['null', 'null'],
  ['invalid URL', JSON.stringify({ node_id: 'comment', html_url: 7, user: { node_id: actor.id } })],
  ['oversized identity', JSON.stringify({ node_id: 'c'.repeat(257), html_url: '', user: { node_id: actor.id } })],
]) {
  it(`preserves an unknown posting outcome for an unusable reply: ${label}`, async () => {
    await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', commentResponse }));
    await expect(createGhOperations(root).createPullRequestComment({ projectPath: root, repository, actor, expected: expectedPull, number: 1, body: 'Synthetic review' }))
      .rejects.toMatchObject({ code: 'GIT_MUTATION_OUTCOME_UNKNOWN' });
    const comments = JSON.parse(await fs.readFile(path.join(root, 'gh-comments.json'), 'utf8'));
    expect(comments).toMatchObject([{ body: 'Synthetic review' }]);
  });
}

it('recovers a delivered SHA-256 review comment after repository casing changes', async () => {
  const head = 'c'.repeat(64);
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'Synthetic', login: 'synthetic', repository: 'Repository', pulls: [{ number: 3, headRefOid: head }] }));
  const gh = createGhOperations(root);
  const created = await gh.createPullRequestComment({ projectPath: root, repository, actor, expected: { ...expectedPull, headRefOid: head }, number: 3, body: `Review\n<!-- garcon-review Synthetic/Repository#3 ${head} -->` });
  const retry = await gh.getPullRequestReviewTarget({ projectPath: root, repository, actor, number: 3, marker: 'garcon-review synthetic/repository#3 ' });
  expect(retry.markedComments).toMatchObject([{ id: created.id, marker: expect.stringContaining(head) }]);
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
  const target = await createGhOperations(root).getPullRequestReviewTarget({ projectPath: root, repository, actor, number: 3, marker: 'garcon-review synthetic/repository#3 ' });
  expect(target.markedComments).toMatchObject([{ id: 'comment-0', marker }]);
});

const first = { id: 1, path: 'example.txt', line: 1, side: 'RIGHT', body: 'first page' };
it('rejects incomplete connections rather than returning a partial list or posting target', async () => {
  await fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic', incompleteConnection: true }));
  const gh = createGhOperations(root);
  await expect(gh.listPullRequests({ projectPath: root })).rejects.toThrow('incomplete connection');
  await expect(gh.getPullRequestReviewTarget({ projectPath: root, repository, actor, number: 1, marker: 'garcon-review ' })).rejects.toThrow('incomplete connection');
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
    const read = await createGhOperations(root).getPullRequestReviewThreads({ projectPath: root, repository, number: 1 });
    expect(read.threads.flatMap(thread => thread.comments.map(comment => comment.body))).toEqual(bodies);
  });
}

for (const expected of [{ host: "another.example.invalid", nameWithOwner: "synthetic/repository" }, { host: "git.example.invalid", nameWithOwner: "other/repository" }]) {
  it(`rejects a checkout with a different saved identity: ${expected.host}/${expected.nameWithOwner}`, async () => {
    await Bun.write(`${root}/gh-fixture.json`, JSON.stringify({ label: "synthetic" }));
    const gh = createGhOperations(root);
    await expect(gh.getPullRequestReviewTarget({ projectPath: root, repository: expected, number: 1, marker: "garcon-review " })).rejects.toThrow(/repository.*changed/i);
    await expect(gh.getPullRequestStatus({ projectPath: root, repository: expected, number: 1 })).rejects.toThrow(/repository.*changed/i);
    await expect(gh.getPullRequestDiff({ projectPath: root, repository: expected, number: 1, commits })).rejects.toThrow(/repository.*changed/i);
    await expect(gh.getPullRequestReviewThreads({ projectPath: root, repository: expected, number: 1 })).rejects.toThrow(/repository.*changed/i);
    await expect(gh.createPullRequestComment({ projectPath: root, repository: expected, actor, expected: expectedPull, number: 1, body: "Review" })).rejects.toThrow(/repository.*changed/i);
    expect(await Bun.file(`${root}/gh-comments.json`).exists()).toBe(false);
  });
}

it("rejects checkout retargeting between target read and comment dispatch", async () => {
  await Bun.write(`${root}/gh-fixture.json`, JSON.stringify({ label: "synthetic" }));
  const gh = createGhOperations(root);
  await gh.getPullRequestReviewTarget({ projectPath: root, repository, number: 1, marker: "garcon-review " });
  await Bun.write(`${root}/gh-fixture.json`, JSON.stringify({ label: "other" }));
  await expect(gh.createPullRequestComment({ projectPath: root, repository, actor, expected: expectedPull, number: 1, body: "Review" })).rejects.toThrow(/repository.*changed/i);
  expect(await Bun.file(`${root}/gh-comments.json`).exists()).toBe(false);
});

it("rejects an account switch between target read and comment dispatch", async () => {
  await Bun.write(`${root}/gh-fixture.json`, JSON.stringify({ label: "synthetic" }));
  const gh = createGhOperations(root);
  await gh.getPullRequestReviewTarget({ projectPath: root, repository, number: 1, marker: "garcon-review " });
  await Bun.write(`${root}/gh-fixture.json`, JSON.stringify({ label: "synthetic", login: "other" }));
  await expect(gh.createPullRequestComment({ projectPath: root, repository, actor, expected: expectedPull, number: 1, body: "Review" })).rejects.toThrow(/account.*changed/i);
  expect(await Bun.file(`${root}/gh-comments.json`).exists()).toBe(false);
});

it("leaves the outcome unknown if auth changes after the actor preflight", async () => {
  const other = { id: "actor:other", login: "other" };
  await Bun.write(`${root}/gh-fixture.json`, JSON.stringify({ label: "synthetic", commentAuthor: other }));
  const gh = createGhOperations(root);
  await expect(gh.createPullRequestComment({ projectPath: root, repository, actor, expected: expectedPull, number: 1, body: `Review\n<!-- garcon-review synthetic/repository#1 ${"a".repeat(40)} -->` })).rejects.toMatchObject({ code: "GIT_MUTATION_OUTCOME_UNKNOWN" });
  const target = await gh.getPullRequestReviewTarget({ projectPath: root, repository, number: 1, marker: "garcon-review " });
  expect(target).toMatchObject({ viewer: actor, markedComments: [{ author: other }] });
});

describe('split pull request reads', () => {
  const readCalls = async () => {
    const file = path.join(root, 'gh-calls.jsonl');
    const lines = (await Bun.file(file).exists()) ? (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean) : [];
    await fs.rm(file, { force: true });
    return lines.map(line => JSON.parse(line).slice(0, 2).join(' '));
  };
  const fixture = (config = {}) => fs.writeFile(path.join(root, 'gh-fixture.json'), JSON.stringify({
    label: 'synthetic', statusChecks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...config,
  }));

  it('reads status without the diff or review comments', async () => {
    await fixture();
    const status = await createGhOperations(root).getPullRequestStatus({ projectPath: root, repository, number: 1 });
    expect(await readCalls()).toEqual(['repo view', 'pr view']);
    expect(status).toMatchObject({ number: 1, ...commits, checks: [{ name: 'ci', state: 'success' }] });
    expect(status).not.toHaveProperty('files');
    expect(status).not.toHaveProperty('fileBodies');
    expect(status).not.toHaveProperty('threads');
  });

  it('reads review threads without the diff or status', async () => {
    await fixture();
    const read = await createGhOperations(root).getPullRequestReviewThreads({ projectPath: root, repository, number: 1 });
    expect(await readCalls()).toEqual(['repo view', 'api --hostname']);
    expect(read.threads).toMatchObject([{ path: 'example.txt', comments: [{ body: 'synthetic comment' }] }]);
  });

  it('fails a review thread read instead of reporting no comments', async () => {
    await fixture({ commentsFail: true });
    await expect(createGhOperations(root).getPullRequestReviewThreads({ projectPath: root, repository, number: 1 })).rejects.toThrow(/forbidden/);
  });

  it('confirms the commit pair after reading a diff and serves the same pair from cache', async () => {
    await fixture({ files: [{ path: 'example.txt', additions: 7, deletions: 5 }] });
    const gh = createGhOperations(root);
    const diff = await gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits });
    expect(await readCalls()).toEqual(['repo view', 'pr diff', 'pr view']);
    expect(diff).toMatchObject({ number: 1, ...commits, files: [{ path: 'example.txt', additions: 7, deletions: 5 }] });
    expect(diff.fileBodies['example.txt'].patch).toContain('+changed');

    expect(await gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits })).toBe(diff);
    expect(await readCalls()).toEqual(['repo view', 'pr view']);
  });

  it('keeps cached diffs per repository and commit pair', async () => {
    await fixture({ pulls: [{ number: 1 }, { number: 2 }] });
    const gh = createGhOperations(root);
    await gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits });
    await gh.getPullRequestDiff({ projectPath: root, repository, number: 2, commits });
    await readCalls();
    const moved = { ...commits, baseRefOid: 'f'.repeat(40) };
    await fixture({ pulls: [{ number: 1, baseRefOid: moved.baseRefOid }, { number: 2 }] });
    await gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits: moved });
    expect(await readCalls()).toEqual(['repo view', 'pr diff', 'pr view']);
    await gh.getPullRequestDiff({ projectPath: root, repository, number: 2, commits });
    expect(await readCalls()).toEqual(['repo view', 'pr view']);
  });

  it('rejects a diff whose pull request moved during the read and does not cache it', async () => {
    const pushed = { headRefOid: 'b'.repeat(40) };
    await fixture({ pushDuringDiff: pushed });
    const gh = createGhOperations(root);
    await expect(gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits })).rejects.toMatchObject({ code: 'GH_STALE_PULL_REQUEST' });
    await readCalls();
    await expect(gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits })).rejects.toMatchObject({ code: 'GH_STALE_PULL_REQUEST' });
    expect(await readCalls()).toEqual(['repo view', 'pr diff', 'pr view']);
    const current = await gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits: { ...commits, ...pushed } });
    expect(current.headRefOid).toBe(pushed.headRefOid);
  });

  it('proves access and the commit pair before serving a cached diff', async () => {
    await fixture();
    const gh = createGhOperations(root);
    await gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits });
    await fixture({ pulls: [{ number: 1, headRefOid: 'b'.repeat(40) }] });
    await expect(gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits })).rejects.toMatchObject({ code: 'GH_STALE_PULL_REQUEST' });
    await fixture({ fail: { 'pr view': 'HTTP 404: Not Found' } });
    await expect(gh.getPullRequestDiff({ projectPath: root, repository, number: 1, commits })).rejects.toThrow(/Not Found/);
  });
});
