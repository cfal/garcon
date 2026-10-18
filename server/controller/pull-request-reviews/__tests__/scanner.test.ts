import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionGhService } from '@garcon/server-agent-interface';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../../common/pull-request-reviews.js';
import { PullRequestReviewScanner } from '../scanner.js';
import { PullRequestReviewStore, REVIEW_HISTORY_BATCH_SIZE, type StoredRepository, type StoredRun } from '../store.js';
import { PullRequestReviewRepositories } from '../service.js';

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
    id: 'repository', nameWithOwner: 'acme/app', url: 'https://github.com/acme/app', viewerLogin: 'viewer', createdAt: '', updatedAt: '',
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
    post: { actor: null, status: 'none', postedAt: null, commentUrl: null, message: null },
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
  const repositories = new PullRequestReviewRepositories({
    store, executors: { requireExecutor() { throw new Error('Unused'); } },
    agents: { hasAgent: () => true, assertExecutorReady() {}, assertExecutionModeSelectionSupported() {}, executionPolicy: () => 'conversation' },
    chats: { hasChat: () => true }, autoReviewStatus: () => null, isPostingRepository: () => false, repositoryUpdated() {}, changed() {}, now: () => clock.now,
  });
  return { directory, store, clock, run, repository, repositories, scanner, list, queued };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

test('scans and refreshes a healthy repository while another repository read is deferred', async () => {
  const { store, scanner, repository, list, clock } = harness();
  const healthy: StoredRepository = {
    ...repository, id: 'healthy', nameWithOwner: 'acme/healthy', url: 'https://github.com/acme/healthy',
    target: { ...repository.target, projectPath: '/work/healthy' },
    settings: { ...repository.settings, autoReview: false },
  };
  store.insertRepository(healthy, { status: 'pending', scannedAt: null, message: null }, []);
  const pending = Promise.withResolvers<ReturnType<typeof list>>();
  let deferredReads = 0;
  let healthyReads = 0;
  const scanning = scanner(async ({ projectPath }) => {
    if (projectPath === repository.target.projectPath) {
      deferredReads++;
      return pending.promise;
    }
    healthyReads++;
    return { ...list([pull(healthyReads === 1 ? HEAD : NEXT_HEAD)]), repo: { nameWithOwner: healthy.nameWithOwner, url: healthy.url } };
  });
  try {
    scanning.start();
    await until(() => store.getRepository(healthy.id)?.scan.status === 'ok');
    expect(deferredReads).toBe(1);
    expect(store.getRepository(repository.id)?.scan.scannedAt).toBeNull();
    clock.now++;
    scanning.requestScan(healthy.id);
    await until(() => store.pulls(healthy.id)[0]?.headRefOid === NEXT_HEAD);
    expect(healthyReads).toBe(2);
    expect(deferredReads).toBe(1);
  } finally {
    scanning.stop();
    pending.resolve(list([pull()]));
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('rejects a checkout retargeted to the same owner and repository on a different host', async () => {
  const { store, scanner, repository, list } = harness();
  const scanning = scanner(async () => ({
    ...list([pull(NEXT_HEAD)]), repo: { nameWithOwner: repository.nameWithOwner, url: 'https://git.example.invalid/acme/app' },
  }));
  scanning.start();
  await until(() => store.getRepository(repository.id)?.scan.status === 'failed'
    || store.getRepository(repository.id)?.url !== repository.url);
  expect(store.getRepository(repository.id)).toMatchObject({ url: repository.url, scan: { status: 'failed' } });
  expect(store.pulls(repository.id)[0]?.headRefOid).toBe(HEAD);
  expect(store.getRun('run')?.state).toBe('completed');
});

test('bounds repository scans and coalesces repeated refreshes of an in-flight repository', async () => {
  const { store, scanner, repository, list } = harness();
  const repositories = [repository];
  for (let index = 1; index < 6; index++) {
    const next = {
      ...repository, id: `repository-${index}`, nameWithOwner: `acme/app-${index}`, url: `https://github.com/acme/app-${index}`,
      target: { ...repository.target, projectPath: `/work/app-${index}` }, settings: { ...repository.settings, autoReview: false },
    };
    store.insertRepository(next, { status: 'pending', scannedAt: null, message: null }, []);
    repositories.push(next);
  }
  const pending: { repository: StoredRepository; resolve(value: ReturnType<typeof list>): void }[] = [];
  let active = 0;
  let maximum = 0;
  const reads = new Map<string, number>();
  const scanning = scanner(async ({ projectPath }) => {
    const current = repositories.find((entry) => entry.target.projectPath === projectPath)!;
    reads.set(current.id, (reads.get(current.id) ?? 0) + 1);
    maximum = Math.max(maximum, ++active);
    const response = Promise.withResolvers<ReturnType<typeof list>>();
    pending.push({ repository: current, resolve: response.resolve });
    try { return await response.promise; }
    finally { active--; }
  });
  const release = (entry: typeof pending[number]) => entry.resolve({
    ...list([pull()]), repo: { nameWithOwner: entry.repository.nameWithOwner, url: entry.repository.url },
  });
  try {
    scanning.start();
    await until(() => pending.length === 4);
    scanning.requestScan(repository.id);
    scanning.requestScan(repository.id);
    expect(reads.get(repository.id)).toBe(1);
    release(pending[0]);
    await until(() => reads.get(repository.id) === 2);
    expect(active).toBe(4);
    expect(maximum).toBe(4);
    release(pending.findLast((entry) => entry.repository.id === repository.id)!);
    await until(() => pending.length === 6);
    expect(reads.get(repository.id)).toBe(2);
    expect(maximum).toBe(4);
  } finally {
    scanning.stop();
    for (const entry of pending) release(entry);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

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
  const retried = Promise.withResolvers<void>();
  let attempts = 0;
  const scanning = scanner(async () => list([]), async () => { await (++attempts === 1 ? pending.promise : retried.promise); });
  scanning.start();
  await until(() => attempts === 1);
  expect(store.getRun(run.id)?.chatArchived).toBe(false);
  pending.reject(new Error('Transient archive failure'));
  await new Promise((resolve) => setImmediate(resolve));
  clock.now += 31 * DAY_MS;
  scanning.requestScan();
  await until(() => attempts === 2);
  expect(store.getRun(run.id)?.chatArchived).toBe(false);
  retried.resolve();
  await until(() => store.getRun(run.id) === null);
  expect(attempts).toBe(2);
  scanning.stop();
  store.close();
  const reopened = new PullRequestReviewStore(directory);
  try {
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

test('does not continue a closed-history archive batch after shutdown and a pending failure', async () => {
  const { store, run, scanner, list } = harness();
  store.insertRun({ ...run, id: 'second-run', chatId: 'second-chat' });
  const pending = Promise.withResolvers<void>();
  let attempts = 0;
  const scanning = scanner(async () => list([]), async () => {
    if (++attempts === 1) await pending.promise;
  });
  scanning.start();
  await until(() => attempts === 1);
  scanning.stop();
  pending.reject(new Error('Archive interrupted during shutdown'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(attempts).toBe(1);
  expect(store.getRun('second-run')?.chatArchived).toBe(false);
});

test.each(['reopen', 'disconnect'] as const)('does not dispatch remaining archives after %s while an admitted archive completes', async (change) => {
  const { store, run, repository, repositories, scanner, list, clock } = harness();
  store.insertRun({ ...run, id: 'second-run', chatId: 'second-chat' });
  const pending = Promise.withResolvers<void>();
  const maintained = Promise.withResolvers<void>();
  const archived: string[] = [];
  let pulls: PullRequestSummary[] = [];
  const scanning = scanner(async () => list(pulls), async (chatId) => {
    archived.push(chatId);
    if (archived.length === 1) await pending.promise;
  });
  const prune = store.pruneClosedPulls.bind(store);
  const maintenance = spyOn(store, 'pruneClosedPulls').mockImplementation((...args) => {
    const removed = prune(...args);
    maintained.resolve();
    return removed;
  });
  try {
    scanning.start();
    await until(() => archived.length === 1);
    if (change === 'reopen') {
      pulls = [pull()];
      clock.now++;
      scanning.requestScan();
      await until(() => store.pulls(repository.id).length === 1);
      expect(store.closedPulls(repository.id, 0)).toEqual([]);
    } else {
      repositories.remove(repository.id);
      scanning.forget(repository.id);
      expect(store.getRepository(repository.id)).toBeNull();
    }
    pending.resolve();
    await maintained.promise;
    expect(archived).toEqual([run.chatId!]);
    if (change === 'reopen') {
      expect(store.getRun(run.id)?.chatArchived).toBe(true);
      expect(store.getRun('second-run')?.chatArchived).toBe(false);
    } else {
      expect(store.getRun(run.id)).toBeNull();
      expect(store.getRun('second-run')).toBeNull();
    }
  } finally {
    pending.resolve();
    maintenance.mockRestore();
  }
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

test('repository uniqueness includes the normalized GitHub host on insert and update', () => {
  const { store, repository } = harness();
  const enterprise = { ...repository, id: 'enterprise', url: 'https://git.example.invalid/acme/app' };
  store.insertRepository(enterprise, { status: 'ok', scannedAt: null, message: null }, []);
  expect(store.listRepositories()).toHaveLength(2);
  expect(() => store.insertRepository(
    { ...enterprise, id: 'duplicate-host', nameWithOwner: 'ACME/APP', url: 'https://GIT.EXAMPLE.INVALID/ACME/APP' },
    { status: 'ok', scannedAt: null, message: null }, [],
  )).toThrow('already connected');
  expect(() => store.updateRepository({ ...enterprise, url: repository.url })).toThrow('already connected');
  expect(store.getRepository(enterprise.id)?.url).toBe(enterprise.url);
  expect(store.available).toBe(true);
});

test('indexed selection preserves head aliases, attempt counts, and active reviews after a push', () => {
  const { store, repository, run, clock } = harness();
  store.insertRun({ ...run, id: 'reviewed-alias', headSha: NEXT_HEAD, reviewedSha: HEAD, state: 'failed',
    createdAt: new Date(clock.now).toISOString(), startedAt: new Date(clock.now).toISOString() });
  store.insertRun({ ...run, id: 'manual-stop', trigger: 'manual', state: 'stopped' });
  store.insertRun({ ...run, id: 'queued-next-head', headSha: NEXT_HEAD, reviewedSha: null, state: 'queued', startedAt: null, chatId: null, turnId: null });
  store.insertRun({ ...run, id: 'unrelated-pull', number: 8, state: 'reviewing' });
  expect(store.selectionHistory(repository.id, 7, HEAD)).toEqual({ active: true, completed: true, stopped: true, attempts: 2 });
  expect(store.selectionHistory(repository.id, 7, NEXT_HEAD)).toEqual({ active: true, completed: false, stopped: false, attempts: 1 });
  expect(store.selectionHistory(repository.id, 9, HEAD)).toEqual({ active: false, completed: false, stopped: false, attempts: 0 });
  expect(store.automaticRunsSince(repository.id, new Date(clock.now - DAY_MS).toISOString())).toBe(1);
});

test('no-op history maintenance keeps the snapshot revision stable', () => {
  const { store, repository, clock } = harness();
  const before = store.revision();
  expect(store.markOutdated(repository.id, 7, HEAD)).toBe(0);
  expect(store.pruneClosedRuns(repository.id, new Date(clock.now).toISOString())).toBe(0);
  expect(store.pruneClosedPulls(repository.id, new Date(clock.now).toISOString())).toBe(0);
  expect(store.revision()).toBe(before);
});

test.each(['unknown', 'posted'] as const)('retains unresolved %s posting history past closure retention', (status) => {
  const { store, run, repository, clock } = harness();
  store.updateRun(run.id, current => ({
    ...current, chatArchived: true,
    post: { ...current.post, status, message: 'Posting needs reconciliation.' },
  }));
  store.recordScan(repository.id, { status: 'ok', scannedAt: new Date(clock.now).toISOString(), message: null }, []);
  clock.now += 31 * DAY_MS;
  const cutoff = new Date(clock.now - 30 * DAY_MS).toISOString();
  expect(store.pruneClosedRuns(repository.id, cutoff)).toBe(0);
  expect(store.recentRuns(1)[0]?.id).toBe(run.id);
  store.updateRun(run.id, current => ({ ...current, post: { ...current.post, status: 'posted', message: null } }));
  expect(store.pruneClosedRuns(repository.id, cutoff)).toBe(1);
});

test('a run update during a list read repeats the scan without losing its posting result', async () => {
  const { store, scanner, list, run } = harness();
  const pending = Promise.withResolvers<ReturnType<typeof list>>();
  let reads = 0;
  const scanning = scanner(async () => ++reads === 1 ? pending.promise : list([pull()]));
  scanning.start();
  await until(() => reads === 1);
  store.updateRun(run.id, (current) => ({ ...current, post: { ...current.post, status: 'posted', commentUrl: 'https://git.example.invalid/comment' } }));
  pending.resolve(list([pull(NEXT_HEAD)]));
  await until(() => reads === 2);
  expect(store.getRun(run.id)).toMatchObject({ state: 'completed', post: { status: 'posted', commentUrl: 'https://git.example.invalid/comment' } });
  expect(store.pulls(run.repositoryId)[0].headRefOid).toBe(HEAD);
});

test('accepts a case-only repository rename and refreshes its display identity', async () => {
  const { store, repository, scanner, list } = harness();
  const scanning = scanner(async () => ({ ...list([pull()]), repo: { nameWithOwner: 'Acme/App', url: 'https://github.com/Acme/App' } }));
  scanning.start();
  await until(() => store.getRepository(repository.id)?.scan.scannedAt !== null);
  expect(store.getRepository(repository.id)).toMatchObject({
    nameWithOwner: 'Acme/App', url: 'https://github.com/Acme/App', scan: { status: 'ok' },
  });
  expect(store.getRun('run')?.state).toBe('completed');
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

test('snapshots and scans read bounded payloads with a large retained review history', async () => {
  const { directory, store, run, scanner, list, repository, repositories } = harness();
  const database = new Database(join(directory, 'pull-request-reviews.sqlite'));
  try {
    const historical = { ...run, title: `Synthetic historical review ${'x'.repeat(512)}`, chatId: null, reviewedSha: null, trigger: 'auto' as const };
    const { id: _id, repositoryId: _repositoryId, number: _number, headSha: _headSha, state: _state, createdAt: _createdAt, ...payload } = historical;
    database.transaction(() => {
      const insert = database.query('INSERT INTO review_runs (id, repository_id, number, head_sha, state, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < 12_000; index++) insert.run(`history-${index}`, repository.id, 7, NEXT_HEAD, 'failed', '2025-01-01T00:00:00Z', JSON.stringify(payload));
    }).immediate();
  } finally { database.close(); }
  const parse = JSON.parse;
  let parsedBytes = 0;
  const parsing = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    parsedBytes += text.length;
    return parse(text, reviver);
  });
  try {
    expect(repositories.snapshot().inbox[0].latestRun?.id).toBe(run.id);
    const scanning = scanner(async () => list([pull()]));
    scanning.start();
    await until(() => store.getRepository(repository.id)?.scan.scannedAt !== null);
    expect(store.getRun(run.id)?.state).toBe('completed');
    expect(parsedBytes).toBeLessThan(512 * 1024);
  } finally { parsing.mockRestore(); }
});

test('large closed-history maintenance yields during archival and deletion in bounded batches', async () => {
  const { directory, store, run, scanner, list, repository, clock } = harness();
  const additionalRuns = REVIEW_HISTORY_BATCH_SIZE * 2 + 50;
  const database = new Database(join(directory, 'pull-request-reviews.sqlite'));
  try {
    const { id: _id, repositoryId: _repositoryId, number: _number, headSha: _headSha, state: _state, createdAt: _createdAt, ...payload } = run;
    database.transaction(() => {
      const insert = database.query('INSERT INTO review_runs (id, repository_id, number, head_sha, state, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < additionalRuns; index++) {
        insert.run(`closed-${index}`, repository.id, 7, HEAD, 'completed', run.createdAt, JSON.stringify({ ...payload, chatId: `closed-chat-${index}` }));
      }
    }).immediate();
  } finally { database.close(); }
  store.recordScan(repository.id, { status: 'ok', scannedAt: new Date(clock.now).toISOString(), message: null }, []);
  clock.now += 31 * DAY_MS;

  let elapsed = 0;
  let archived = 0;
  let observedArchivalProgress: number | null = null;
  let observedDeletionProgress = false;
  const archivalBatches: number[] = [];
  const deletedBatches: number[] = [];
  const readArchive = store.runsToArchive.bind(store);
  const prune = store.pruneClosedRuns.bind(store);
  const performanceClock = spyOn(performance, 'now').mockImplementation(() => elapsed);
  const archiveReads = spyOn(store, 'runsToArchive').mockImplementation((...args) => {
    const runs = readArchive(...args);
    archivalBatches.push(runs.length);
    return runs;
  });
  const deletion = spyOn(store, 'pruneClosedRuns').mockImplementation((...args) => {
    const removed = prune(...args);
    deletedBatches.push(removed);
    elapsed += 11;
    if (deletedBatches.length === 1) {
      setImmediate(() => { observedDeletionProgress = store.getRun(`closed-${additionalRuns - 1}`) !== null; });
    }
    return removed;
  });
  try {
    const scanning = scanner(async () => list([]), async () => {
      archived++;
      elapsed += 6;
      if (archived === 1) setImmediate(() => { observedArchivalProgress = archived; });
    });
    scanning.start();
    await until(() => store.getRun(`closed-${additionalRuns - 1}`) === null);
    expect(archived).toBe(additionalRuns + 1);
    expect(observedArchivalProgress).toBeGreaterThan(0);
    expect(observedArchivalProgress).toBeLessThan(additionalRuns + 1);
    expect(observedDeletionProgress).toBe(true);
    expect(archivalBatches).toEqual([REVIEW_HISTORY_BATCH_SIZE, REVIEW_HISTORY_BATCH_SIZE, 51]);
    expect(deletedBatches).toEqual([REVIEW_HISTORY_BATCH_SIZE, REVIEW_HISTORY_BATCH_SIZE, 51]);
  } finally {
    performanceClock.mockRestore();
    archiveReads.mockRestore();
    deletion.mockRestore();
  }
}, 30_000);
