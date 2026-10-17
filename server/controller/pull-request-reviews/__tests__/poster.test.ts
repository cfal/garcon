import { afterEach, expect, mock, test } from 'bun:test';
import type { ExecutionGhService } from '@garcon/server-agent-interface';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitServiceError } from '../../../../common/git-error.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import { PullRequestReviewPoster } from '../poster.js';
import { PullRequestReviewStore, type StoredRepository, type StoredRun } from '../store.js';

const HEAD = 'a'.repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'garcon-poster-'));
  const store = new PullRequestReviewStore(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const repository: StoredRepository = {
    id: 'repository', nameWithOwner: 'acme/app', url: '', viewerLogin: 'viewer', createdAt: '', updatedAt: '',
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
    createdAt: '', startedAt: '', finishedAt: '', post: { status: 'none', postedAt: null, commentUrl: null, message: null },
  };
  store.insertRun(run);
  store.updateRun(run.id, current => current, `Reviewed commit: ${HEAD}`);
  const scope = { executorId: 'local', instanceId: 'instance' };
  const gh = {
    getPullRequestReviewTarget: mock<ExecutionGhService['getPullRequestReviewTarget']>(async () => ({
      ...scope, number: 7, state: 'open', headRefOid: HEAD, markedComments: [],
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
  pending.resolve({ ...scope, number: 7, state: 'open', headRefOid: HEAD, markedComments: [] });
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
      ...scope, number: 7, state, headRefOid: 'b'.repeat(40),
      markedComments: [{ id: 'already-posted', url: 'https://github.invalid/existing', marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false }],
    });
    await poster.post('run');
    expect(gh.createPullRequestComment).toHaveBeenCalledTimes(1);
    expect(store.getRun('run')).toMatchObject({ state: 'outdated', post: { status: 'posted', commentUrl: 'https://github.invalid/existing' } });
  });
}

for (const failure of ['throw', 'false'] as const) {
  test(`retries ${failure} minimization without posting a second comment`, async () => {
    const { store, poster, gh, scope } = harness();
    gh.getPullRequestReviewTarget.mockResolvedValue({
      ...scope, number: 7, state: 'open', headRefOid: HEAD,
      markedComments: [{ id: 'old', url: '', marker: `<!-- garcon-review acme/app#7 ${'b'.repeat(40)} -->`, isMinimized: false }],
    });
    if (failure === 'throw') gh.minimizePullRequestComment.mockRejectedValueOnce(new Error('Temporary failure'));
    else gh.minimizePullRequestComment.mockResolvedValueOnce({ ...scope, minimized: false });
    await poster.post('run');
    expect(store.getRun('run')?.post.status).toBe('posted');
    expect(store.getRun('run')?.post.message).toContain('older');
    gh.getPullRequestReviewTarget.mockResolvedValueOnce({
      ...scope, number: 7, state: 'open', headRefOid: HEAD,
      markedComments: [
        { id: 'old', url: '', marker: `<!-- garcon-review acme/app#7 ${'b'.repeat(40)} -->`, isMinimized: false },
        { id: 'new', url: 'https://github.invalid/new', marker: `<!-- garcon-review acme/app#7 ${HEAD} -->`, isMinimized: false },
        { id: 'later', url: '', marker: `<!-- garcon-review acme/app#7 ${'c'.repeat(40)} -->`, isMinimized: false },
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
    ...scope, number: 7, state: 'open', headRefOid: HEAD,
    markedComments: [{ id: 'later', url: '', marker: `<!-- garcon-review acme/app#7 ${'b'.repeat(40)} -->`, isMinimized: false }],
  });
  await poster.post('run');
  expect(store.getRun('run')?.post).toMatchObject({ status: 'posted', message: expect.stringContaining('could not be found') });
  expect(gh.createPullRequestComment).not.toHaveBeenCalled();
  expect(gh.minimizePullRequestComment).not.toHaveBeenCalled();
});
