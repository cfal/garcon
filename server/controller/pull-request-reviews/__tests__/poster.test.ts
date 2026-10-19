import { afterEach, expect, mock, test } from 'bun:test';
import { AgentCallError, type ExecutionGhService } from '@garcon/server-agent-interface';
import { mkdtempSync, rmSync, watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitServiceError } from '../../../../common/git-error.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import { PullRequestReviewPoster } from '../poster.js';
import { PullRequestReviewStore, type StoredRepository, type StoredRun } from '../store.js';
import { PullRequestReviewRepositories } from '../service.js';
import { createGhOperations } from '../../../runtime/gh/gh-service.js';
import { GitRuntime } from '../../../runtime/git/runtime.js';

const REPOSITORY = { host: "github.invalid", nameWithOwner: "acme/app" };
const ACTOR = { id: "actor-a", login: "viewer" };
const HEAD = 'a'.repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'garcon-poster-'));
  const store = new PullRequestReviewStore(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const repository: StoredRepository = {
    id: 'repository', nameWithOwner: 'acme/app', url: 'https://github.invalid/acme/app', viewerLogin: 'viewer', createdAt: '', updatedAt: '',
    target: {
      type: 'new-chat', agentId: 'claude', projectPath: '/work/app', model: 'model', apiProviderId: null, modelEndpointId: null,
      modelProtocol: null, permissionMode: 'plan', thinkingMode: 'none', agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' },
    },
    settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  };
  store.insertRepository(repository, { status: 'ok', scannedAt: null, message: null }, []);
  const run: StoredRun = {
    id: 'run', repositoryId: repository.id, number: 7, headSha: HEAD, reviewedSha: HEAD, state: 'completed',
    title: 'Synthetic change', trigger: 'manual', message: null, chatId: 'chat', turnId: 'turn', chatArchived: false,
    createdAt: '', startedAt: '', finishedAt: '', post: { actor: null, status: 'none', postedAt: null, commentUrl: null, message: null },
  };
  store.insertRun(run);
  store.updateRun(run.id, current => current, `Reviewed commit: ${HEAD}`);
  const scope = { executorId: 'local', instanceId: 'instance' };
  const gh = {
    getPullRequestReviewTarget: mock<ExecutionGhService['getPullRequestReviewTarget']>(async () => ({
      ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD, markedComments: [],
    })),
    createPullRequestComment: mock<ExecutionGhService['createPullRequestComment']>(async () => ({ ...scope, id: 'new', url: 'https://github.invalid/new' })),
    minimizePullRequestComment: mock<ExecutionGhService['minimizePullRequestComment']>(async () => ({ ...scope, minimized: true })),
  };
  const executors = { requireExecutor: () => ({ getGhService: async () => ({
      ...gh, getStatus: async () => { throw new Error('Unused'); },
      getPullRequest: async () => { throw new Error('Unused'); }, listPullRequests: async () => { throw new Error('Unused'); },
    }) }) };
  const poster = new PullRequestReviewPoster({
    store, executors, changed() {}, now: () => Date.parse('2026-03-01T00:00:00Z'),
  });
  const repositories = new PullRequestReviewRepositories({
    store, executors, changed() {}, now: () => 0, repositoryUpdated() {}, autoReviewStatus: () => null,
    isPostingRepository: id => poster.isPostingRepository(id), chats: { hasChat: () => true },
    agents: {
      hasAgent: () => { throw new Error('Unused'); }, assertExecutorReady() { throw new Error('Unused'); },
      assertExecutionModeSelectionSupported() { throw new Error('Unused'); }, executionPolicy: () => { throw new Error('Unused'); },
    },
  });
  return { store, poster, gh, scope, directory, repositories };
}

async function useRuntimeGh({ directory, gh, scope }: ReturnType<typeof harness>) {
  const bin = join(directory, 'bin');
  await fs.mkdir(bin);
  await fs.copyFile(new URL('../../../remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
  await fs.chmod(join(bin, 'gh'), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  cleanups.push(() => { process.env.PATH = previousPath; });
  const runtime = createGhOperations(directory);
  gh.getPullRequestReviewTarget.mockImplementation(async request => ({ ...scope, ...await runtime.getPullRequestReviewTarget({ ...request, projectPath: directory }) }));
  gh.createPullRequestComment.mockImplementation(async request => ({ ...scope, ...await runtime.createPullRequestComment({ ...request, projectPath: directory }) }));
  return { label: 'acme', repository: 'app', host: REPOSITORY.host, login: ACTOR.login, viewerId: ACTOR.id, pulls: [{ number: 7 }] };
}

test('does not post head A when head B is scanned during the executor actor preflight', async () => {
  const setup = harness();
  const { directory, poster, store } = setup;
  const config = await useRuntimeGh(setup);
  const fixture = join(directory, 'gh-fixture.json');
  await fs.writeFile(fixture, JSON.stringify({ ...config, holdPostingActor: true }));
  const started = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, file) => { if (file === 'gh-actor-started') started.resolve(); });
  const posting = poster.post('run');
  try {
    await started.promise;
    await fs.writeFile(fixture, JSON.stringify({ ...config, pulls: [{ number: 7, headRefOid: 'b'.repeat(40) }] }));
    store.updateRun('run', current => ({ ...current, state: 'outdated' }));
    await fs.writeFile(join(directory, 'gh-actor-release'), 'released');
    await posting;
    expect(store.getRun('run')).toMatchObject({ state: 'outdated', post: { status: 'stale' } });
    expect(store.hasUnknownPost('repository')).toBe(false);
    expect(await Bun.file(join(directory, 'gh-comments.json')).exists()).toBe(false);
  } finally {
    watcher.close();
    await fs.writeFile(join(directory, 'gh-actor-release'), 'released');
    await posting;
  }
});

test('retains a delivered comment after a network error and reconciles after push and closure', async () => {
  const setup = harness();
  const { directory, poster, store, repositories, gh } = setup;
  const config = await useRuntimeGh(setup);
  const fixture = join(directory, 'gh-fixture.json');
  await fs.writeFile(fixture, JSON.stringify({ ...config, commentFailureAfterWrite: 'Post: connection reset by peer' }));
  await poster.post('run');
  expect(store.getRun('run')?.post).toMatchObject({ status: 'unknown', actor: ACTOR });
  expect(() => repositories.remove('repository')).toThrow('unconfirmed post');
  await fs.writeFile(fixture, JSON.stringify({ ...config, pulls: [{ number: 7, state: 'CLOSED', headRefOid: 'b'.repeat(40) }] }));
  store.updateRun('run', current => ({ ...current, state: 'outdated' }));
  await poster.post('run');
  expect(store.getRun('run')).toMatchObject({ state: 'outdated', post: { status: 'posted', actor: ACTOR } });
  expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await fs.readFile(join(directory, 'gh-comments.json'), 'utf8'))).toHaveLength(1);
});

test('records a definite HTTP rejection as failed and allows disconnecting', async () => {
  const setup = harness();
  const config = await useRuntimeGh(setup);
  await fs.writeFile(join(setup.directory, 'gh-fixture.json'), JSON.stringify({ ...config, commentRejection: 'gh: Resource not accessible by integration (HTTP 403)' }));
  await setup.poster.post('run');
  expect(setup.store.getRun('run')?.post.status).toBe('failed');
  expect(await Bun.file(join(setup.directory, 'gh-comments.json')).exists()).toBe(false);
  expect(() => setup.repositories.remove('repository')).not.toThrow();
});

for (const outcome of ['not-dispatched', 'rejected', 'unknown'] as const) {
  test(`preserves the executor's ${outcome} delivery outcome when posting`, async () => {
    const { store, poster, gh, repositories } = harness();
    gh.createPullRequestComment.mockRejectedValueOnce(new AgentCallError(outcome, 'Executor delivery failed'));
    await poster.post('run');
    expect(store.getRun('run')?.post).toMatchObject({
      status: outcome === 'unknown' ? 'unknown' : 'failed', actor: ACTOR,
    });
    expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
    if (outcome === 'unknown') expect(() => repositories.remove('repository')).toThrow('unconfirmed post');
    else expect(() => repositories.remove('repository')).not.toThrow();
  });
}

for (const failure of ['missing checkout', 'invalid comment'] as const) {
  test(`does not lock the connection when runtime preflight rejects a ${failure}`, async () => {
    const { store, poster, gh, directory, repositories } = harness();
    const runtime = new GitRuntime({ executorId: 'local', instanceId: 'instance', projectBasePath: directory, assertAvailable() {} });
    cleanups.push(() => runtime.dispose());
    if (failure === 'invalid comment') store.updateRun('run', current => current, `Reviewed commit: ${HEAD}\n\0`);
    gh.createPullRequestComment.mockImplementationOnce(request => runtime.gh.createPullRequestComment({
      ...request, projectPath: failure === 'missing checkout' ? join(directory, 'removed-checkout') : directory,
    }));
    await poster.post('run');
    expect(store.getRun('run')?.post.status).toBe('failed');
    expect(await Bun.file(join(directory, 'gh-comments.json')).exists()).toBe(false);
    expect(() => repositories.remove('repository')).not.toThrow();
  });
}

test('preserves an earlier unknown outcome when the recovery read is rejected', async () => {
  const { store, poster, gh } = harness();
  gh.createPullRequestComment.mockRejectedValueOnce(new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Reply lost'));
  await poster.post('run');
  gh.getPullRequestReviewTarget.mockRejectedValueOnce(new GitServiceError('GH_FORBIDDEN', 'HTTP 403'));
  await poster.post('run');
  expect(store.getRun('run')?.post).toMatchObject({ status: 'unknown', actor: ACTOR });
  expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
});

for (const reason of ['deleted PR', 'another actor'] as const) {
  test(`explicitly abandons an unresolved post for ${reason} without resending or deleting its audit`, async () => {
    const { store, poster, gh, scope, repositories } = harness();
    gh.createPullRequestComment.mockRejectedValueOnce(new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Reply lost'));
    await poster.post('run');
    if (reason === 'deleted PR') gh.getPullRequestReviewTarget.mockRejectedValueOnce(new GitServiceError('GH_NOT_FOUND', 'Deleted PR'));
    else gh.getPullRequestReviewTarget.mockResolvedValueOnce({
      ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD,
      markedComments: [{ id: 'other', url: '', marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false, author: { id: 'other', login: 'other' } }],
    });
    await poster.post('run');
    expect(store.hasUnknownPost('repository')).toBe(true);
    poster.abandon('run');
    expect(store.getRun('run')).toMatchObject({ review: expect.stringContaining(HEAD), post: { status: 'abandoned', actor: ACTOR, abandonedAt: '2026-03-01T00:00:00.000Z' } });
    expect(store.recoveryRuns().runs).toHaveLength(0);
    await expect(poster.post('run')).rejects.toThrow('abandoned');
    expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(() => repositories.remove('repository')).not.toThrow();
  });
}

test('cannot abandon a post while its executor call is in flight', async () => {
  const { poster, gh, scope, store } = harness();
  const pending = Promise.withResolvers<Awaited<ReturnType<ExecutionGhService['createPullRequestComment']>>>();
  gh.createPullRequestComment.mockImplementationOnce(() => pending.promise);
  const posting = poster.post('run');
  await new Promise(resolve => setImmediate(resolve));
  expect(() => poster.abandon('run')).toThrow('being posted');
  pending.resolve({ ...scope, id: 'new', url: '' });
  await posting;
  expect(store.getRun('run')?.post.status).toBe('posted');
  expect(() => poster.abandon('run')).toThrow('unresolved');
});

for (const host of [REPOSITORY.host, 'enterprise.invalid']) {
test(`coordinates connections on different executors for ${host}`, async () => {
  const { store, poster, gh, scope } = harness();
  const repository = store.getRepository('repository')!;
  store.insertRepository({ ...repository, id: 'other-repository', url: `https://${host}/acme/app`, target: { ...repository.target, executorId: 'other-executor' } }, repository.scan, []);
  const original = store.getRun('run')!;
  store.insertRun({ ...original, id: 'other-run', repositoryId: 'other-repository' });
  store.updateRun('other-run', current => current, original.review);
  gh.getPullRequestReviewTarget.mockImplementation(async request => ({
    ...scope, repository: request.repository, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD, markedComments: [],
  }));
  const expectedCreates = host === REPOSITORY.host ? 1 : 2;
  const pending = Promise.withResolvers<Awaited<ReturnType<ExecutionGhService['createPullRequestComment']>>>();
  gh.createPullRequestComment.mockImplementation(() => pending.promise);
  const first = poster.post('run');
  await new Promise(resolve => setImmediate(resolve));
  const second = poster.post('other-run').then(() => null, error => error);
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(gh.createPullRequestComment).toHaveBeenCalledTimes(expectedCreates);
  } finally {
    pending.resolve({ ...scope, id: 'new', url: 'https://github.invalid/new' });
    await first;
    await second;
  }
  if (host === REPOSITORY.host) expect(await second).toMatchObject({ message: expect.stringContaining('already being posted') });
  else expect(await second).toBeNull();
  gh.getPullRequestReviewTarget.mockResolvedValueOnce({
    ...scope, repository: { ...REPOSITORY, host }, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD,
    markedComments: [{ id: 'new', url: 'https://github.invalid/new', marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false, author: ACTOR }],
  });
  await poster.post('other-run');
  expect(store.getRun('other-run')?.post.status).toBe('posted');
  expect(gh.createPullRequestComment).toHaveBeenCalledTimes(expectedCreates);
});
}

test('does not overwrite durable admission when the executor returns an unclassified failure', async () => {
  const { store, poster, gh, repositories } = harness();
  gh.createPullRequestComment.mockRejectedValueOnce(new Error('The executor reply was lost'));
  await poster.post('run');
  expect(store.getRun('run')?.post).toMatchObject({ status: 'unknown', actor: ACTOR });
  expect(() => repositories.remove('repository')).toThrow('unconfirmed post');
});

test('does not publish a delayed target after a newer scan invalidates the review', async () => {
  const { store, poster, gh, scope } = harness();
  const pending = Promise.withResolvers<Awaited<ReturnType<ExecutionGhService['getPullRequestReviewTarget']>>>();
  gh.getPullRequestReviewTarget.mockImplementationOnce(() => pending.promise);
  const posting = poster.post('run');
  await new Promise(resolve => setImmediate(resolve));
  store.updateRun('run', current => ({ ...current, state: 'outdated' }));
  pending.resolve({ ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD, markedComments: [] });
  await posting;
  expect(gh.createPullRequestComment).not.toHaveBeenCalled();
  expect(store.getRun('run')?.state).toBe('outdated');
});

for (const state of ['open', 'closed'] as const) {
  test(`reconciles an unknown post after the pull request ${state === 'open' ? 'moves to another head' : 'closes'}`, async () => {
    const { store, poster, gh, scope } = harness();
    gh.createPullRequestComment.mockRejectedValueOnce(new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Reply lost'));
    await poster.post('run');
    expect(store.getRun('run')?.post.status).toBe('unknown');
    store.updateRun('run', current => ({ ...current, state: 'outdated' }));
    gh.getPullRequestReviewTarget.mockResolvedValueOnce({
      ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state, headRefOid: 'b'.repeat(40),
      markedComments: [{ id: 'already-posted', url: 'https://github.invalid/existing', marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false, author: ACTOR }],
    });
    await poster.post('run');
    expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(store.getRun('run')).toMatchObject({ state: 'outdated', post: { actor: ACTOR, status: 'posted', commentUrl: 'https://github.invalid/existing' } });
  });
}

for (const failure of ['throw', 'false'] as const) {
  test(`retries ${failure} minimization without posting a second comment`, async () => {
    const { store, poster, gh, scope } = harness();
    gh.getPullRequestReviewTarget.mockResolvedValue({
      ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD,
      markedComments: [{ id: 'old', url: '', marker: `<!-- garcon-review acme/app#7 ${'b'.repeat(40)} -->`, isMinimized: false, author: ACTOR }],
    });
    if (failure === 'throw') gh.minimizePullRequestComment.mockRejectedValueOnce(new Error('Temporary failure'));
    else gh.minimizePullRequestComment.mockResolvedValueOnce({ ...scope, minimized: false });
    await poster.post('run');
    expect(store.getRun('run')?.post.status).toBe('posted');
    expect(store.getRun('run')?.post.message).toContain('older');
    gh.getPullRequestReviewTarget.mockResolvedValueOnce({
      ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD,
      markedComments: [
        { id: 'old', url: '', marker: `<!-- garcon-review acme/app#7 ${'b'.repeat(40)} -->`, isMinimized: false, author: ACTOR },
        { id: 'new', url: 'https://github.invalid/new', marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false, author: ACTOR },
        { id: 'later', url: '', marker: `<!-- garcon-review acme/app#7 ${'c'.repeat(40)} -->`, isMinimized: false, author: ACTOR },
      ],
    });
    await poster.post('run');
    expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(gh.minimizePullRequestComment).toHaveBeenCalledTimes(2);
    expect(store.getRun('run')?.post).toMatchObject({ status: 'posted', message: null });
  });
}

test('keeps cleanup failure visible if the posted marker disappears', async () => {
  const { store, poster, gh, scope } = harness();
  store.updateRun('run', current => ({ ...current, post: {
    status: 'posted', commentUrl: 'https://github.invalid/new', postedAt: '', message: 'Older comments need cleanup.',
  } }));
  gh.getPullRequestReviewTarget.mockResolvedValueOnce({
    ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: 'open', headRefOid: HEAD,
    markedComments: [{ id: 'later', url: '', marker: `<!-- garcon-review acme/app#7 ${'b'.repeat(40)} -->`, isMinimized: false, author: ACTOR }],
  });
  await poster.post('run');
  expect(store.getRun('run')?.post).toMatchObject({ status: 'posted', message: expect.stringContaining('could not be found') });
  expect(gh.createPullRequestComment).not.toHaveBeenCalled();
  expect(gh.minimizePullRequestComment).not.toHaveBeenCalled();
});

for (const status of ['unknown', 'posted'] as const) {
  test(`keeps ${status} posting recovery visible beyond the recent-run limit`, () => {
    const { store } = harness();
    const run = store.getRun('run')!;
    store.updateRun(run.id, current => ({ ...current, post: { ...current.post, status, message: 'Needs recovery' } }));
    for (let index = 1; index <= 2; index++) {
      store.insertRun({ ...run, id: `newer-${index}`, createdAt: `2026-03-0${index}T00:00:00Z` });
    }
    expect(store.recentRuns(2).map(current => current.id)).toEqual(['run', 'newer-2']);
    store.updateRun(run.id, current => ({ ...current, post: { ...current.post, status: 'posted', message: null } }));
    expect(store.recentRuns(2).map(current => current.id)).toEqual(['newer-2', 'newer-1']);
  });
}

test("persists the posting actor before dispatching a comment", async () => {
  const { store, poster, gh, scope } = harness();
  gh.createPullRequestComment.mockImplementationOnce(async (request) => {
    expect(store.getRun("run")?.post).toMatchObject({ status: "unknown", actor: ACTOR });
    expect(request).toMatchObject({ repository: REPOSITORY, actor: ACTOR, expected: { state: 'open', headRefOid: HEAD } });
    return { ...scope, id: "new", url: "https://github.invalid/new" };
  });
  await poster.post("run");
  expect(store.getRun("run")?.post).toMatchObject({ status: "posted", actor: ACTOR });
});

test("does not resend an unknown post after switching GitHub accounts", async () => {
  const { store, poster, gh, scope } = harness();
  gh.createPullRequestComment.mockRejectedValueOnce(new GitServiceError("GIT_MUTATION_OUTCOME_UNKNOWN", "Reply lost"));
  await poster.post("run");
  gh.getPullRequestReviewTarget.mockResolvedValueOnce({ ...scope, repository: REPOSITORY, viewer: { id: "actor-b", login: "other" }, number: 7, state: "open", headRefOid: HEAD, markedComments: [] });
  await poster.post("run");
  expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
  expect(store.getRun("run")?.post).toMatchObject({ status: "unknown", actor: ACTOR, message: expect.stringContaining("viewer") });
});

test("recovers the attempted actor marker under a different viewer without mutating comments", async () => {
  const { store, poster, gh, scope } = harness();
  gh.createPullRequestComment.mockRejectedValueOnce(new GitServiceError("GIT_MUTATION_OUTCOME_UNKNOWN", "Reply lost"));
  await poster.post("run");
  gh.getPullRequestReviewTarget.mockResolvedValueOnce({ ...scope, repository: REPOSITORY, viewer: { id: "actor-b", login: "other" }, number: 7, state: "closed", headRefOid: HEAD, markedComments: [
    { id: "older", url: "", marker: `<!-- garcon-review acme/app#7 ${"b".repeat(40)} -->`, isMinimized: false, author: ACTOR },
    { id: "new", url: "https://github.invalid/existing", marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false, author: ACTOR },
  ] });
  await poster.post("run");
  expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
  expect(gh.minimizePullRequestComment).not.toHaveBeenCalled();
  expect(store.getRun("run")?.post).toMatchObject({ status: "posted", actor: ACTOR, commentUrl: "https://github.invalid/existing", message: expect.stringContaining("viewer") });
});

test("does not resend an unknown attempt when its marker appears under another actor", async () => {
  const { store, poster, gh, scope } = harness();
  gh.createPullRequestComment.mockRejectedValueOnce(new GitServiceError("GIT_MUTATION_OUTCOME_UNKNOWN", "Author changed after preflight"));
  await poster.post("run");
  gh.getPullRequestReviewTarget.mockResolvedValueOnce({ ...scope, repository: REPOSITORY, viewer: ACTOR, number: 7, state: "open", headRefOid: HEAD, markedComments: [
    { id: "new", url: "https://github.invalid/existing", marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false, author: { id: "actor-b", login: "other" } },
  ] });
  await poster.post("run");
  expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
  expect(gh.minimizePullRequestComment).not.toHaveBeenCalled();
  expect(store.getRun("run")?.post).toMatchObject({ status: "unknown", actor: ACTOR, message: expect.stringContaining("another author") });
});
