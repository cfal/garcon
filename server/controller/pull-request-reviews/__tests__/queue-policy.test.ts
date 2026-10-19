import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionGhService } from '@garcon/server-agent-interface';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, type PullRequestReviewSettings } from '../../../../common/pull-request-reviews.js';
import type { CommandLedgerRecord } from '../../commands/command-ledger.js';
import { PullRequestReviews, type PullRequestReviewsDeps } from '../setup.js';
import { PullRequestReviewRunner, type PullRequestReviewRunnerDeps } from '../runner.js';
import { PullRequestReviewStore, type StoredRepository, type StoredRun } from '../store.js';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-17T12:00:00Z');
const DAY_MS = 24 * 60 * 60_000;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function pull(number = 7, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number, title: 'Synthetic change', state: 'open', isDraft: false, author: 'author', headRefName: 'feature', baseRefName: 'main',
    additions: 10, deletions: 2, changedFiles: 1, createdAt: '', updatedAt: '', url: '', reviewDecision: null, checksState: 'none',
    headRefOid: HEAD, isCrossRepository: false, authorAssociation: 'member', authorIsBot: false, authoredByViewer: false,
    labels: [], reviewRequest: null, ...overrides,
  };
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'garcon-review-queue-policy-'));
  const store = new PullRequestReviewStore(directory);
  cleanups.push(() => { store.close(); rmSync(directory, { force: true, recursive: true }); });
  const repository: StoredRepository = {
    id: 'repository', nameWithOwner: 'acme/app', url: 'https://github.com/acme/app', viewerLogin: 'viewer',
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    target: { type: 'new-chat', agentId: 'claude', projectPath: '/work/app', model: 'model', apiProviderId: null,
      modelEndpointId: null, modelProtocol: null, permissionMode: 'plan', thinkingMode: 'none', agentSettingsById: {},
      tags: [], preambleChoice: { mode: 'defaults' } },
    settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true, debounceMinutes: 0 },
  };
  const scan = { status: 'ok' as const, scannedAt: new Date(NOW).toISOString(), message: null };
  store.insertRepository(repository, scan, [pull(), pull(8)]);
  const starts: string[] = [];
  const terminal = new Map<string, () => void>();
  const github = { reads: 0 };
  const runnerDeps = {
    store, poster: { async post() {} },
    commands: {
      async submitScheduledStart(input) {
        starts.push(input.chatId);
        return { success: true, commandType: 'chat-start', clientRequestId: input.clientRequestId, status: 'accepted', acceptedAt: '',
          chat: null, chatId: input.chatId, turnId: `turn-${input.chatId}` };
      },
      async submitStop() { throw new Error('Unused Stop'); },
    },
    chatIds: { allocate: () => `chat-${starts.length + 1}` },
    turns: { waitForTurnTerminal(chatId, turnId) {
      return new Promise<CommandLedgerRecord | null>((resolve) => terminal.set(chatId, () => resolve({
        key: 'key', commandType: 'chat-start', payloadHash: 'hash', payload: {}, chatId, turnId,
        clientRequestId: 'request', acceptedAt: '', updatedAt: '', publicTerminalAt: '', status: 'finished',
        turnResult: { availability: 'available', text: `Reviewed commit: ${HEAD}`, bytes: 60 },
      })));
    } },
    chatNames: { async setSessionName() {} }, changed() {}, now: () => NOW,
  } satisfies PullRequestReviewRunnerDeps;
  const runner = new PullRequestReviewRunner(runnerDeps);
  cleanups.push(() => runner.stop());
  const gh = {
    async listPullRequests() { github.reads++; return { executorId: 'local', instanceId: 'instance', pulls: store.pulls(repository.id),
      repo: { nameWithOwner: repository.nameWithOwner, url: repository.url }, viewerLogin: 'viewer' }; },
    async getStatus() { throw new Error('Unused'); }, async getPullRequest() { throw new Error('Unused'); },
    async getPullRequestReviewTarget() { throw new Error('Unused'); }, async createPullRequestComment() { throw new Error('Unused'); },
    async minimizePullRequestComment() { throw new Error('Unused'); },
  } satisfies ExecutionGhService;
  const serviceDeps = {
    ...runnerDeps,
    agents: { hasAgent: () => true, assertExecutorReady() {}, assertExecutionModeSelectionSupported() {}, executionPolicy: () => 'conversation' },
    executors: { requireExecutor: () => ({ async getGhService() { return gh; } }) },
    chats: { hasChat: () => true }, archiveChat: async () => {}, onInvalidated() {},
  } satisfies PullRequestReviewsDeps;
  return { store, runner, repository, starts, terminal, scan, serviceDeps, github };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

function historicalRun(repositoryId: string, overrides: Partial<StoredRun> = {}): StoredRun {
  return { id: 'historical', repositoryId, number: 7, headSha: HEAD, state: 'interrupted', createdAt: new Date(NOW).toISOString(),
    title: 'Synthetic change', reviewedSha: null, trigger: 'auto', message: null, chatId: null, turnId: null,
    startedAt: null, finishedAt: new Date(NOW).toISOString(), chatArchived: false,
    post: { actor: null, status: 'none', commentUrl: null, postedAt: null, message: null }, ...overrides };
}

test.each([
  ['disabled automatic review', { autoReview: false }],
  ['requested reviews only', { onlyWhenReviewRequested: true }],
  ['excluded base branch', { filters: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS.filters, baseBranches: ['release'] } }],
  ['lower daily limit', { dailyReviewLimit: 1 }],
] satisfies [string, Partial<PullRequestReviewSettings>][])(
  'rechecks %s before starting a queued automatic review', async (_label, changes) => {
    const { runner, store, repository, starts, terminal } = harness();
    runner.enqueue(repository.id, pull(), 'auto');
    const queued = runner.enqueue(repository.id, pull(8), 'auto');
    runner.start();
    await until(() => terminal.has('chat-1'));
    store.updateRepository({ ...repository, settings: { ...repository.settings, ...changes } });
    terminal.get('chat-1')!();
    await until(() => store.getRun(queued.id)?.state !== 'queued');
    expect(starts).toEqual(['chat-1']);
    expect(store.getRun(queued.id)).toMatchObject({ state: 'interrupted', startedAt: null, chatId: null });
  },
);

test('rechecks latest pull-request filters before starting an automatic review', async () => {
  const { runner, store, repository, starts, terminal, scan } = harness();
  runner.enqueue(repository.id, pull(), 'auto');
  const queued = runner.enqueue(repository.id, pull(8), 'auto');
  runner.start();
  await until(() => terminal.has('chat-1'));
  store.recordScan(repository.id, scan, [pull(), pull(8, { isDraft: true })]);
  terminal.get('chat-1')!();
  await until(() => store.getRun(queued.id)?.state !== 'queued');
  expect(starts).toEqual(['chat-1']);
});

test('manual queued reviews still start after automatic review is disabled', async () => {
  const { runner, store, repository, starts, terminal } = harness();
  runner.enqueue(repository.id, pull(), 'manual');
  runner.enqueue(repository.id, pull(8), 'manual');
  runner.start();
  await until(() => terminal.has('chat-1'));
  store.updateRepository({ ...repository, settings: { ...repository.settings, autoReview: false } });
  terminal.get('chat-1')!();
  await until(() => starts.length === 2);
  expect(starts).toEqual(['chat-1', 'chat-2']);
});

test('saving settings cancels queued automatic reviews before a blocked scan can finish', async () => {
  const { store, repository, serviceDeps, terminal } = harness();
  const service = new PullRequestReviews(store, serviceDeps);
  cleanups.push(() => service.stop());
  service.start();
  await until(() => terminal.has('chat-1') && store.activeRuns().some((run) => run.number === 8 && run.state === 'queued'));
  const queued = store.activeRuns().find((run) => run.number === 8)!;
  const gh = await serviceDeps.executors.requireExecutor().getGhService();
  const result = await gh.listPullRequests();
  const pending = Promise.withResolvers<typeof result>();
  gh.listPullRequests = () => pending.promise;
  try {
    await service.update(repository.id, { target: repository.target, settings: { ...repository.settings, autoReview: false } });
    expect(store.getRun(queued.id)).toMatchObject({ state: 'interrupted', startedAt: null });
    expect(store.getRun(queued.id)?.message).toContain('settings changed');
  } finally {
    pending.resolve(result);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('successive scans reserve queued reviews within the daily start budget', async () => {
  const { store, repository, serviceDeps, terminal, scan, github } = harness();
  store.updateRepository({ ...repository, settings: { ...repository.settings, dailyReviewLimit: 2 } });
  store.recordScan(repository.id, scan, [pull(), pull(8), pull(9)]);
  const service = new PullRequestReviews(store, serviceDeps);
  cleanups.push(() => service.stop());
  service.start();
  await until(() => terminal.has('chat-1') && store.activeRuns().length === 2);
  expect(store.queuedAutomaticRunCount(repository.id)).toBe(1);
  expect(store.automaticRunsSince(repository.id, new Date(NOW - DAY_MS).toISOString())).toBe(1);
  const reads = github.reads;
  service.scan(repository.id);
  await until(() => github.reads > reads);
  await new Promise((resolve) => setImmediate(resolve));
  expect(store.runsForPull(repository.id, 9).runs).toEqual([]);
  expect(store.activeRuns()).toHaveLength(2);
});

test('queued reviews interrupted by restart do not consume attempts or daily starts', () => {
  const { store, repository } = harness();
  store.insertRun(historicalRun(repository.id, { state: 'queued' }));
  expect(store.interruptActiveRuns(new Date(NOW).toISOString())).toBe(1);
  expect(store.selectionHistory(repository.id, 7, HEAD)).toMatchObject({ active: false, attempts: 0 });
  expect(store.automaticRunsSince(repository.id, new Date(NOW - DAY_MS).toISOString())).toBe(0);
});

test('start limits use start time when a run waited in the queue across the daily cutoff', () => {
  const { store, repository } = harness();
  store.insertRun(historicalRun(repository.id, { createdAt: new Date(NOW - 2 * DAY_MS).toISOString(), startedAt: new Date(NOW).toISOString() }));
  expect(store.automaticRunsSince(repository.id, new Date(NOW - DAY_MS).toISOString())).toBe(1);
  expect(store.selectionHistory(repository.id, 7, HEAD).attempts).toBe(1);
});
