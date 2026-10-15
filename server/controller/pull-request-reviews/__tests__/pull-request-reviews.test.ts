import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, PULL_REQUEST_REVIEW_MAX_REPOSITORIES, type PullRequestReviewSettings } from '../../../../common/pull-request-reviews.js';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { PullRequestReviews, type PullRequestReviewsDeps } from '../setup.js';
import { PullRequestReviewStore } from '../store.js';
import { BashToolUseMessage } from '../../../../common/chat-types.js';
import { transcriptViewId } from '../../ledger/contracts.js';
import type { CommandLedgerRecord } from '../../commands/command-ledger.js';

const HEAD = 'a'.repeat(40);
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function pull(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 7, title: 'Keep queue controls stable', state: 'open', isDraft: false, author: 'author', headRefName: 'feature',
    baseRefName: 'main', additions: 10, deletions: 2, changedFiles: 1, createdAt: '', updatedAt: '', url: '', reviewDecision: null,
    checksState: 'passing', headRefOid: HEAD, isCrossRepository: false, authorAssociation: 'member', authorIsBot: false,
    authoredByViewer: false, labels: [], reviewRequest: 'me', ...overrides,
  };
}

// A synthetic GitHub with one repository, and an agent whose turns end when the test says so.
function harness(directory = mkdtempSync(join(tmpdir(), 'garcon-reviews-'))) {
  directories.push(directory);
  const github = { pulls: [pull()], comments: [] as { id: string; body: string; minimized: boolean }[] };
  const turns = new Map<string, (text: string) => void>();
  const starts: { chatId: string; command: string; tags: string[] }[] = [];
  const scope = { executorId: 'local', instanceId: 'instance' };
  const gh = {
    async getStatus() { throw new Error('Unused status read'); },
    async getPullRequest() { throw new Error('Unused detail read'); },
    async listPullRequests() {
      return { ...scope, pulls: github.pulls, repo: { nameWithOwner: 'acme/app', url: 'https://github.com/acme/app' }, viewerLogin: 'viewer' };
    },
    async getPullRequestReviewTarget({ number }: { number: number }) {
      const current = github.pulls.find((entry) => entry.number === number)!;
      return {
        ...scope, number, state: 'open' as const, headRefOid: current.headRefOid,
        markedComments: github.comments.map((comment) => ({ id: comment.id, url: `https://github.com/c/${comment.id}`, marker: /<!--.*-->/.exec(comment.body)![0], isMinimized: comment.minimized })),
      };
    },
    async createPullRequestComment({ body }: { body: string }) {
      const id = `comment-${github.comments.length + 1}`;
      github.comments.push({ id, body, minimized: false });
      return { ...scope, id, url: `https://github.com/c/${id}` };
    },
    async minimizePullRequestComment({ commentId }: { commentId: string }) {
      github.comments.find((comment) => comment.id === commentId)!.minimized = true;
      return { ...scope, minimized: true };
    },
  };
  let chatCount = 0;
  const deps = {
    executors: { requireExecutor: () => ({ getGhService: async () => gh }) },
    agents: { hasAgent: () => true, assertExecutorReady() {}, assertExecutionModeSelectionSupported() {}, executionPolicy: () => 'conversation' as const },
    chats: { hasChat: () => true },
    commands: {
      async submitScheduledStart(input: { chatId: string; command: string; tags: string[] }) {
        starts.push(input);
        return { success: true as const, commandType: 'chat-start', clientRequestId: 'request', status: 'accepted' as const, acceptedAt: '', chat: null, chatId: input.chatId, turnId: `turn-${input.chatId}` };
      },
      async submitStop() { return { success: true as const, commandType: 'chat-stop', clientRequestId: 'stop', status: 'accepted' as const, acceptedAt: '' }; },
    },
    chatIds: { allocate: () => `chat-${++chatCount}` },
    turns: {
      waitForTurnTerminal: (chatId: string, turnId: string) => new Promise<CommandLedgerRecord | null>((resolve) => {
        turns.set(chatId, (text) => resolve({
          key: 'key', commandType: 'chat-start', payloadHash: 'hash', payload: {},
          chatId, turnId, clientRequestId: 'request', acceptedAt: '', updatedAt: '', publicTerminalAt: '2026-01-01T00:00:00Z',
          status: 'finished', turnResult: { availability: 'available', text, bytes: text.length },
        }));
      }),
    },
    chatNames: { setSessionName: async () => ({}) },
    archiveChat: async () => {},
    onInvalidated() {},
  } satisfies PullRequestReviewsDeps;
  const reviews = new PullRequestReviews(new PullRequestReviewStore(directory), deps);
  return { reviews, github, turns, starts, directory, deps };
}

const target = {
  type: 'new-chat', agentId: 'claude', projectPath: '/work/app', model: 'model', apiProviderId: null, modelEndpointId: null,
  modelProtocol: null, permissionMode: 'plan', thinkingMode: 'none', agentSettingsById: {}, tags: [], preambleChoice: { mode: 'defaults' },
};

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setImmediate(resolve));
  expect(check()).toBe(true);
}

async function connect(reviews: PullRequestReviews, settings: Partial<PullRequestReviewSettings>) {
  return reviews.connect({ target, settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, debounceMinutes: 0, ...settings } });
}

const latestRun = (reviews: PullRequestReviews) => reviews.snapshot().inbox[0].latestRun;

test('reviews a new pull request automatically and posts the review as a comment', async () => {
  const { reviews, github, turns, starts } = harness();
  await connect(reviews, { autoReview: true, posting: 'comment' });
  reviews.start();
  await until(() => turns.has('chat-1'));
  expect(starts[0].command).toContain('Review acme/app#7 comprehensively.');
  expect(starts[0].tags).toEqual(['auto-review']);
  expect(latestRun(reviews)?.state).toBe('reviewing');

  turns.get('chat-1')!(`No findings.\n\nReviewed commit: ${HEAD}`);
  await until(() => latestRun(reviews)?.post.status === 'posted');

  expect(latestRun(reviews)).toMatchObject({ state: 'completed', reviewedSha: HEAD, chatId: 'chat-1' });
  expect(github.comments.map((comment) => comment.body)).toEqual([`No findings.\n\nReviewed commit: ${HEAD}\n\n<!-- garcon-review acme/app#7 ${HEAD} -->`]);
  reviews.stop();
});

test('tracks a permission committed before startup returns and arms its timeout', async () => {
  const { reviews, deps, turns } = harness();
  const repository = await connect(reviews, {});
  const submit = deps.commands.submitScheduledStart;
  deps.commands.submitScheduledStart = async (input) => {
    const viewId = transcriptViewId('synthetic-view');
    reviews.handleTranscriptCommit({
      type: 'permission', chatId: input.chatId, runId: 'run', viewId,
      row: { kind: 'permission-requested', viewId, ordinal: 1, at: '', providerMeta: null,
        lifecycle: { kind: 'requested', permissionOccurrenceId: '11111111-1111-4111-8111-111111111111', requestedTool: new BashToolUseMessage('', 'tool', 'pwd'), options: [] } },
    });
    return submit(input);
  };
  const timer = spyOn(globalThis, 'setTimeout');
  try {
    reviews.start();
    reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    expect(latestRun(reviews)?.state).toBe('needs-input');
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 30 * 60_000);
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'completed');
  } finally { timer.mockRestore(); reviews.stop(); reviews.close(); }
});

test('retries failed archival on the next successful scan', async () => {
  const { reviews, github, turns, deps } = harness();
  const repository = await connect(reviews, {});
  let attempts = 0;
  deps.archiveChat = async () => { if (++attempts === 1) throw new Error('Transient archive failure'); };
  // The scanner captures this port during construction.
  reviews.close();
  const store = new PullRequestReviewStore(directories.at(-1)!);
  const service = new PullRequestReviews(store, deps);
  service.start();
  service.review(repository.id, 7);
  await until(() => turns.has('chat-1'));
  turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
  await until(() => latestRun(service)?.state === 'completed');
  github.pulls = [];
  service.scan(repository.id);
  await until(() => attempts === 1);
  await new Promise((resolve) => setImmediate(resolve));
  const run = store.runsForRepository(repository.id)[0];
  expect(run.chatArchived).toBe(false);
  service.scan(repository.id);
  await until(() => store.getRun(run.id)?.chatArchived === true);
  expect(attempts).toBe(2);
  service.stop(); service.close();
});

test('keeps a draft review until it is posted, and refuses to post after new commits', async () => {
  const { reviews, github, turns } = harness();
  const repository = await connect(reviews, { posting: 'draft' });
  reviews.start();
  const run = reviews.review(repository.id, 7);
  await until(() => turns.has('chat-1'));
  turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
  await until(() => latestRun(reviews)?.state === 'completed');
  expect(github.comments).toEqual([]);

  github.pulls = [pull({ headRefOid: 'b'.repeat(40) })];
  await reviews.postRun(run.id);

  expect(latestRun(reviews)).toMatchObject({ state: 'outdated', post: { status: 'stale' } });
  expect(github.comments).toEqual([]);
  reviews.stop();
});

test('fails a review whose response names no commit', async () => {
  const { reviews, turns } = harness();
  const repository = await connect(reviews, {});
  reviews.start();
  reviews.review(repository.id, 7);
  await until(() => turns.has('chat-1'));
  turns.get('chat-1')!('Looks fine.');
  await until(() => latestRun(reviews)?.state === 'failed');
  expect(reviews.runs(repository.id, 7)[0]).toMatchObject({ message: 'The review does not name the commit it reviewed.', review: 'Looks fine.' });
  reviews.stop();
});

test('marks reviews that were running when the controller stopped as interrupted', async () => {
  const first = harness();
  const repository = await connect(first.reviews, {});
  first.reviews.start();
  first.reviews.review(repository.id, 7);
  await until(() => first.turns.has('chat-1'));
  first.reviews.stop();
  first.reviews.close();

  const restarted = harness(first.directory);
  restarted.reviews.start();
  expect(latestRun(restarted.reviews)?.state).toBe('interrupted');
  restarted.reviews.stop();
});

test('reopens saved repositories and review text without schema version metadata', async () => {
  const first = harness();
  const repository = await connect(first.reviews, {});
  first.reviews.start();
  const run = first.reviews.review(repository.id, 7);
  await until(() => first.turns.has('chat-1'));
  const text = `No findings.\n\nReviewed commit: ${HEAD}`;
  first.turns.get('chat-1')!(text);
  await until(() => latestRun(first.reviews)?.state === 'completed');
  const revision = first.reviews.snapshot().revision;
  first.reviews.stop();
  first.reviews.close();

  const database = new Database(join(first.directory, 'pull-request-reviews.sqlite'));
  try {
    expect(database.query('PRAGMA user_version').get()).toEqual({ user_version: 0 });
  } finally { database.close(); }

  const reopened = harness(first.directory);
  try {
    expect(reopened.reviews.snapshot()).toMatchObject({ revision, repositories: [{ id: repository.id }] });
    expect(reopened.reviews.runs(repository.id, 7)).toMatchObject([{ id: run.id, state: 'completed', review: text }]);
  } finally { reopened.reviews.close(); }
});

test('runs one review per repository within the workspace concurrency limit', async () => {
  const { reviews, github, turns, starts } = harness();
  github.pulls.push(pull({ number: 8 }));
  const local = await connect(reviews, {});
  const remote = await reviews.connect({
    target: { ...target, executorId: '11111111-1111-4111-8111-111111111111' }, settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  });
  reviews.start();
  try {
    const first = reviews.review(local.id, 7);
    const queued = reviews.review(local.id, 8);
    reviews.review(remote.id, 7);
    await until(() => turns.size === 2);
    expect(starts).toHaveLength(2);
    expect(reviews.runs(local.id, 8)[0]).toMatchObject({ id: queued.id, state: 'queued', chatId: null });
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => starts.length === 3);
    expect(reviews.runs(local.id, 7)[0]).toMatchObject({ id: first.id, state: 'completed' });
    expect(reviews.runs(local.id, 8)[0]).toMatchObject({ id: queued.id, state: 'reviewing', chatId: 'chat-3' });
  } finally { reviews.stop(); reviews.close(); }
});

test('posts a review of the live head even when the scanner cached the preceding head', async () => {
  const { reviews, github, turns } = harness();
  const repository = await connect(reviews, { posting: 'comment' });
  reviews.start();
  reviews.review(repository.id, 7);
  await until(() => turns.has('chat-1'));
  const liveHead = 'b'.repeat(40);
  github.pulls = [pull({ headRefOid: liveHead })];
  turns.get('chat-1')!(`Reviewed commit: ${liveHead}`);
  await until(() => latestRun(reviews)?.post.status === 'posted');
  expect(latestRun(reviews)?.state).toBe('completed');
  expect(github.comments).toHaveLength(1);
  reviews.stop();
});

test('continues scanning other pull requests when a push arrives during a review', async () => {
  const { reviews, github, turns, starts } = harness();
  const repository = await connect(reviews, { autoReview: true });
  reviews.start();
  try {
    await until(() => turns.has('chat-1'));
    const nextHead = 'b'.repeat(40);
    github.pulls = [pull({ headRefOid: nextHead }), pull({ number: 8 })];
    reviews.scan(repository.id);
    await until(() => reviews.runs(repository.id, 8).length === 1);
    expect(reviews.runs(repository.id, 7)).toMatchObject([{ state: 'reviewing', headSha: HEAD }]);
    expect(reviews.runs(repository.id, 8)).toMatchObject([{ state: 'queued' }]);
    expect(starts).toHaveLength(1);

    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => turns.has('chat-2'));
    reviews.scan(repository.id);
    await until(() => reviews.runs(repository.id, 7).length === 2);
    expect(reviews.runs(repository.id, 7)).toMatchObject([
      { state: 'queued', headSha: nextHead }, { state: 'outdated', reviewedSha: HEAD },
    ]);
  } finally { reviews.stop(); reviews.close(); }
});

test('allows disabling reviews and posting while the preserved executor is offline', async () => {
  const { reviews, deps } = harness();
  const repository = await connect(reviews, { autoReview: true, posting: 'comment' });
  deps.agents.assertExecutorReady = () => { throw new Error('Executor offline'); };
  const updated = await reviews.update(repository.id, {
    target: repository.target,
    settings: { ...repository.settings, autoReview: false, posting: 'off' },
  });
  expect(updated.settings).toMatchObject({ autoReview: false, posting: 'off' });
  await expect(reviews.update(repository.id, {
    target: { ...repository.target, projectPath: '/work/other' }, settings: updated.settings,
  })).rejects.toThrow('Executor offline');
  reviews.close();
});

test('rejects slash commands when updating a preserved conversation target', async () => {
  const { reviews } = harness();
  const repository = await connect(reviews, {});
  await expect(reviews.update(repository.id, {
    target: repository.target, settings: { ...repository.settings, prompt: '/compact' },
  })).rejects.toThrow('cannot start with a slash command');
  expect(reviews.snapshot().repositories[0].settings.prompt).toBe(repository.settings.prompt);
  reviews.close();
});

test('refuses to move a connection onto an executor that already owns this repository', async () => {
  const { reviews } = harness();
  const local = await connect(reviews, {});
  const remote = await reviews.connect({
    target: { ...target, executorId: '11111111-1111-4111-8111-111111111111' }, settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  });
  await expect(reviews.update(remote.id, { target: local.target, settings: remote.settings })).rejects.toThrow('already connected');
  expect(reviews.snapshot().repositories).toHaveLength(2);
  reviews.close();
});

test('serializes concurrent connects at the repository limit', async () => {
  const { reviews, directory } = harness();
  const database = new Database(join(directory, 'pull-request-reviews.sqlite'));
  try {
    database.transaction(() => {
      const insert = database.query('INSERT INTO review_repositories VALUES (?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < PULL_REQUEST_REVIEW_MAX_REPOSITORIES - 1; index++) {
        const repository = { id: `seed-${index}`, nameWithOwner: `acme/seed-${index}`, target, settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, viewerLogin: 'viewer', url: '', createdAt: '', updatedAt: '' };
        insert.run(repository.id, JSON.stringify(repository), JSON.stringify({ status: 'ok', scannedAt: null, message: null }), '[]', 'local', repository.nameWithOwner);
      }
    }).immediate();
  } finally { database.close(); }
  const results = await Promise.allSettled([
    connect(reviews, {}),
    reviews.connect({ target: { ...target, executorId: '11111111-1111-4111-8111-111111111111' }, settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find((result) => result.status === 'rejected');
  expect(failure?.status === 'rejected' && failure.reason.message).toContain('At most 50');
  expect(reviews.snapshot().repositories).toHaveLength(50);
  reviews.close();
});
