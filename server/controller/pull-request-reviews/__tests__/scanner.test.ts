import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionGhService } from '@garcon/server-agent-interface';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import { PullRequestReviewScanner } from '../scanner.js';
import { PullRequestReviewStore, type StoredRepository, type StoredRun } from '../store.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const DAY_MS = 24 * 60 * 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function pull(head = HEAD): PullRequestSummary {
  return {
    number: 7, title: 'Synthetic change', state: 'open', isDraft: false, author: 'author', headRefName: 'feature',
    baseRefName: 'main', additions: 10, deletions: 2, changedFiles: 1, createdAt: '', updatedAt: '', url: '', reviewDecision: null,
    checksState: 'passing', headRefOid: head, isCrossRepository: false, authorAssociation: 'member', authorIsBot: false,
    authoredByViewer: false, labels: [], reviewRequest: 'me',
  };
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'garcon-review-scanner-'));
  const store = new PullRequestReviewStore(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const clock = { now: Date.parse('2026-03-01T00:00:00Z') };
  const repository: StoredRepository = {
    id: 'repository', nameWithOwner: 'acme/app', url: '', viewerLogin: 'viewer', createdAt: '', updatedAt: '',
    target: {
      type: 'new-chat', agentId: 'claude', projectPath: '/work/app', model: 'model', apiProviderId: null, modelEndpointId: null,
      modelProtocol: null, permissionMode: 'plan', thinkingMode: 'none', agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' },
    },
    settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true, debounceMinutes: 0 },
  };
  store.insertRepository(repository, { status: 'ok', scannedAt: null, message: null }, [pull()]);
  const run: StoredRun = {
    id: 'run', repositoryId: repository.id, number: 7, headSha: HEAD, reviewedSha: HEAD, state: 'completed',
    createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:00Z',
    title: 'Synthetic change', trigger: 'auto', message: null, chatId: 'chat', turnId: 'turn', chatArchived: false,
    post: { status: 'none', postedAt: null, commentUrl: null, message: null },
  };
  store.insertRun(run);
  const queued: string[] = [];
  const scanner = (listPullRequests: ExecutionGhService['listPullRequests'], archiveChat: (id: string) => Promise<void> = async () => {}) => {
    const gh = {
      listPullRequests,
      async getStatus() { throw new Error('Unused'); },
      async getPullRequest() { throw new Error('Unused'); },
      async getPullRequestReviewTarget() { throw new Error('Unused'); },
      async createPullRequestComment() { throw new Error('Unused'); },
      async minimizePullRequestComment() { throw new Error('Unused'); },
    } satisfies ExecutionGhService;
    const result = new PullRequestReviewScanner({
      store, executors: { requireExecutor: () => ({ getGhService: async () => gh }) },
      runner: { enqueue: (_id, next) => { queued.push(next.headRefOid); return run; }, pump() {} },
      archiveChat, changed() {}, now: () => clock.now,
    });
    cleanups.push(() => result.stop());
    return result;
  };
  const list = (pulls: PullRequestSummary[]) => ({
    executorId: 'local', instanceId: 'instance', pulls, repo: { nameWithOwner: repository.nameWithOwner, url: repository.url }, viewerLogin: 'viewer',
  });
  return { directory, store, clock, run, repository, scanner, list, queued };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

test('discards a pending old-head list when a review settles during the read', async () => {
  const { store, scanner, list, queued, run } = harness();
  store.updateRun(run.id, (current) => ({ ...current, state: 'reviewing', reviewedSha: null }));
  const pending = Promise.withResolvers<ReturnType<typeof list>>();
  let reads = 0;
  const scanning = scanner(async () => ++reads === 1 ? pending.promise : list([pull(NEXT_HEAD)]));
  scanning.start();
  await until(() => reads === 1);
  store.updateRun(run.id, (current) => ({ ...current, state: 'completed', reviewedSha: NEXT_HEAD }));
  pending.resolve(list([pull()]));
  await until(() => store.pulls(run.repositoryId)[0]?.headRefOid === NEXT_HEAD || store.getRun(run.id)?.state === 'outdated');
  expect(store.getRun(run.id)?.state).toBe('completed');
  expect(queued).toEqual([]);
  expect(reads).toBe(2);
});

test('retains an old review until closure retention elapses and archival succeeds', async () => {
  const { directory, store, clock, run, scanner, list } = harness();
  const pending = Promise.withResolvers<void>();
  let attempts = 0;
  const scanning = scanner(async () => list([]), async () => { if (++attempts === 1) await pending.promise; });
  scanning.start();
  await until(() => attempts === 1);
  expect(store.getRun(run.id)?.chatArchived).toBe(false);
  pending.reject(new Error('Transient archive failure'));
  await new Promise((resolve) => setImmediate(resolve));
  clock.now += 31 * DAY_MS;
  scanning.requestScan();
  await until(() => store.getRun(run.id)?.chatArchived === true);
  expect(attempts).toBe(2);
  scanning.stop();
  store.close();
  const reopened = new PullRequestReviewStore(directory);
  try {
    expect(reopened.getRun(run.id)?.chatArchived).toBe(true);
    reopened.pruneClosedRuns(run.repositoryId, new Date(clock.now).toISOString());
    expect(reopened.getRun(run.id)).toBeNull();
  } finally { reopened.close(); }
});

test('reopening a pull request resets its closure retention', async () => {
  const { store, clock, run, scanner, list } = harness();
  let pulls: PullRequestSummary[] = [];
  const scanning = scanner(async () => list(pulls));
  scanning.start();
  await until(() => store.getRun(run.id)?.chatArchived === true);
  clock.now += 29 * DAY_MS;
  pulls = [pull()];
  scanning.requestScan();
  await until(() => store.pulls(run.repositoryId).length === 1);
  clock.now += 2 * DAY_MS;
  pulls = [];
  scanning.requestScan();
  await until(() => store.pulls(run.repositoryId).length === 0);
  expect(store.getRun(run.id)).not.toBeNull();
  clock.now += 29 * DAY_MS;
  scanning.requestScan();
  await until(() => store.getRepository(run.repositoryId)?.scan.scannedAt === new Date(clock.now).toISOString());
  expect(store.getRun(run.id)).not.toBeNull();
  clock.now += 2 * DAY_MS;
  scanning.requestScan();
  await until(() => store.getRun(run.id) === null);
});

test('the initial schema rejects normalized duplicate repository identities', () => {
  const { store, repository } = harness();
  expect(() => store.insertRepository(
    { ...repository, id: 'duplicate', nameWithOwner: 'ACME/APP' },
    { status: 'ok', scannedAt: null, message: null }, [],
  )).toThrow('already connected');
  expect(store.listRepositories()).toHaveLength(1);
  expect(store.available).toBe(true);
});

test('prunes closed runs without chats while preserving active work', async () => {
  const { store, clock, run, scanner, list } = harness();
  store.updateRun(run.id, (current) => ({ ...current, chatId: null }));
  store.insertRun({ ...run, id: 'active', state: 'reviewing', chatId: null });
  const scanning = scanner(async () => list([]));
  scanning.start();
  await until(() => store.getRepository(run.repositoryId)?.scan.scannedAt !== null);
  clock.now += 31 * DAY_MS;
  scanning.requestScan();
  await until(() => store.getRun(run.id) === null);
  expect(store.getRun('active')?.state).toBe('reviewing');
});
