import { afterEach, expect, mock, test } from 'bun:test';
import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitServiceError } from '../../../../common/git-error.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import { PullRequestReviewPoster } from '../poster.js';
import { PullRequestReviewStore, type StoredRepository, type StoredRun } from '../store.js';

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
  const poster = new PullRequestReviewPoster({
    store, changed() {}, now: () => Date.parse('2026-03-01T00:00:00Z'),
    executors: { requireExecutor: () => ({ getGhService: async () => ({
      ...gh, getStatus: async () => { throw new Error('Unused'); },
      getPullRequest: async () => { throw new Error('Unused'); }, listPullRequests: async () => { throw new Error('Unused'); },
    }) }) },
  });
  return { store, poster, gh, scope };
}

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
    expect(request).toMatchObject({ repository: REPOSITORY, actor: ACTOR });
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
