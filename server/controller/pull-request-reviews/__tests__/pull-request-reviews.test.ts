import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, PULL_REQUEST_REVIEW_MAX_REPOSITORIES, PULL_REQUEST_REVIEW_RUN_PAGE_SIZE, type PullRequestReviewSettings } from '../../../../common/pull-request-reviews.js';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { PullRequestReviews, type PullRequestReviewsDeps } from '../setup.js';
import { PullRequestReviewStore } from '../store.js';
import { BashToolUseMessage } from '../../../../common/chat-types.js';
import { transcriptViewId } from '../../ledger/contracts.js';
import type { CommandLedgerRecord } from '../../commands/command-ledger.js';
import type { AgentStopResponse } from '../../../../common/chat-command-contracts.js';
import { emptyChatExecutionControlState } from '../../../../common/chat-execution-control.js';
import { GitServiceError } from '../../../../common/git-error.js';
import createPullRequestReviewRoutes from '../../routes/pull-request-reviews.js';
import { TURN_RESULT_BYTE_LIMIT } from '../../commands/command-ledger.js';
import type { PullRequestReviewRunsResponse, PullRequestReviewRecoveryResponse } from '../../../../common/pull-request-reviews.js';

const POSTING_ACTOR = { id: "actor:viewer", login: "viewer" };
const REPOSITORY = { host: "github.com", nameWithOwner: "acme/app" };
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
function harness(directory = mkdtempSync(join(tmpdir(), 'garcon-reviews-')), now = Date.now) {
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
        ...scope, repository: REPOSITORY, viewer: POSTING_ACTOR, number, state: 'open' as const, headRefOid: current.headRefOid,
        markedComments: github.comments.map((comment) => ({ id: comment.id, url: `https://github.com/c/${comment.id}`, marker: /<!--.*-->/.exec(comment.body)![0], author: POSTING_ACTOR, isMinimized: comment.minimized })),
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
    agents: { hasAgent: () => true, assertExecutorReady() {}, assertExecutionModeSelectionSupported() {}, executionPolicy: (): 'conversation' | 'literal' => 'conversation' },
    chats: { hasChat: () => true },
    commands: {
      async submitScheduledStart(input: { chatId: string; command: string; tags: string[] }) {
        starts.push(input);
        return { success: true as const, commandType: 'chat-start', clientRequestId: 'request', status: 'accepted' as const, acceptedAt: '', chat: null, chatId: input.chatId, turnId: `turn-${input.chatId}` };
      },
      async submitStop(_input: { chatId: string; clientRequestId: string }): Promise<AgentStopResponse> {
        return { success: true, commandType: 'chat-stop', clientRequestId: 'stop', status: 'accepted', acceptedAt: '', outcome: 'interrupt-requested', control: emptyChatExecutionControlState('instance') };
      },
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
    now,
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

function seedHistory(directory: string, repositoryId: string, count: number, review: string, unknown = false): void {
  const database = new Database(join(directory, 'pull-request-reviews.sqlite'));
  try {
    database.transaction(() => {
      database.query('INSERT OR IGNORE INTO review_pulls (repository_id, number) VALUES (?, 7)').run(repositoryId);
      const insert = database.query(`INSERT INTO review_runs (id, repository_id, number, head_sha, state, created_at, payload_json, review)
        VALUES (?, ?, 7, ?, 'completed', ?, ?, ?)`);
      for (let index = 0; index < count; index++) {
        const at = new Date(Date.parse('2026-01-01T00:00:00Z') + index).toISOString();
        insert.run(`history-${String(index).padStart(3, '0')}`, repositoryId, HEAD, at, JSON.stringify({
          title: 'Synthetic change', reviewedSha: HEAD, trigger: 'manual', message: null,
          chatId: null, turnId: null, chatArchived: true, startedAt: at, finishedAt: at,
          post: { actor: null, status: unknown ? 'unknown' : 'none', postedAt: null, commentUrl: null, message: null },
        }), review);
      }
    }).immediate();
  } finally { database.close(); }
}

test('requires explicit abandonment confirmation and retains the audit across restart', async () => {
  const { reviews, directory, deps } = harness();
  const repository = await connect(reviews, {});
  seedHistory(directory, repository.id, 1, `Reviewed commit: ${HEAD}`, true);
  const routes = createPullRequestReviewRoutes({ service: reviews, referencesApiProvider: () => false, handleChatRemoved() {}, start() {}, stop() {}, close() {} });
  const url = new URL('http://localhost/api/v1/pull-request-reviews/runs/abandon');
  const post = (body: unknown) => routes[url.pathname].POST!(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), url);
  expect((await post({ runId: 'history-000' })).status).toBe(400);
  expect((await post({ runId: 'history-000', confirm: false })).status).toBe(400);
  expect(reviews.recoveryRuns().runs).toHaveLength(1);
  const response = await post({ runId: 'history-000', confirm: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ run: { post: { status: 'abandoned', abandonedAt: expect.any(String) } } });
  reviews.close();
  const restarted = new PullRequestReviews(new PullRequestReviewStore(directory), deps);
  try {
    expect(restarted.runDetail('history-000')).toMatchObject({ review: `Reviewed commit: ${HEAD}`, post: { status: 'abandoned' } });
    expect(restarted.recoveryRuns().runs).toHaveLength(0);
    await expect(restarted.postRun('history-000')).rejects.toThrow('abandoned');
    expect(() => restarted.remove(repository.id)).not.toThrow();
  } finally { restarted.close(); }
});

test('paginates maximum-size review history without serializing bodies or blocking health requests', async () => {
  const { reviews, directory } = harness();
  const repository = await connect(reviews, {});
  const review = 'x'.repeat(TURN_RESULT_BYTE_LIMIT);
  seedHistory(directory, repository.id, 50, review);
  const routes = createPullRequestReviewRoutes({
    service: reviews, referencesApiProvider: () => false, handleChatRemoved() {}, start() {}, stop() {}, close() {},
  });
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    return routes[url.pathname]?.GET?.(request, url) ?? new Response('missing', { status: 404 });
  } });
  try {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const query = new URLSearchParams({ repositoryId: repository.id, number: '7' });
      if (cursor) query.set('cursor', cursor);
      const started = performance.now();
      const [response, health] = await Promise.all([
        fetch(`${server.url}api/v1/pull-request-reviews/runs?${query}`), fetch(`${server.url}health`),
      ]);
      const text = await response.text();
      expect(health.status).toBe(200);
      expect(performance.now() - started).toBeLessThan(500);
      expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
      const page = JSON.parse(text) as PullRequestReviewRunsResponse;
      expect(page.runs).toHaveLength(Math.min(PULL_REQUEST_REVIEW_RUN_PAGE_SIZE, 50 - ids.length));
      expect(page.runs.every(run => !('review' in run))).toBe(true);
      ids.push(...page.runs.map(run => run.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
    const detail = await fetch(`${server.url}api/v1/pull-request-reviews/runs/detail?runId=${ids[0]}`);
    expect((await detail.json()).run.review).toBe(review);
    const invalid = await fetch(`${server.url}api/v1/pull-request-reviews/runs?repositoryId=${repository.id}&number=7&cursor=malformed`);
    expect(invalid.status).toBe(400);
  } finally { await server.stop(true); reviews.close(); }
}, 30_000);

test('keeps all 101 closed unresolved posts actionable beyond the recent-run cap', async () => {
  const { reviews, directory } = harness();
  const repository = await connect(reviews, {});
  seedHistory(directory, repository.id, 101, `Reviewed commit: ${HEAD}`, true);
  const store = new PullRequestReviewStore(directory);
  store.recordScan(repository.id, { status: 'ok', scannedAt: new Date().toISOString(), message: null }, []);
  try {
    expect(reviews.snapshot().inbox).toHaveLength(0);
    expect(reviews.snapshot().recentRuns.some(run => run.id === 'history-000')).toBe(false);
    expect(() => reviews.remove(repository.id)).toThrow('unconfirmed post');
    const routes = createPullRequestReviewRoutes({ service: reviews, referencesApiProvider: () => false, handleChatRemoved() {}, start() {}, stop() {}, close() {} });
    const recovered: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL('http://localhost/api/v1/pull-request-reviews/runs/recovery');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await routes[url.pathname].GET(new Request(url), url);
      const page = await response.json() as PullRequestReviewRecoveryResponse;
      recovered.push(...page.runs.map(run => run.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(recovered).toHaveLength(101);
    expect(recovered.at(-1)).toBe('history-000');
    // Marker absence after closure settles the oldest unknown without creating a comment.
    store.updateRun(recovered.at(-1)!, run => ({ ...run, state: 'outdated' }));
    await reviews.postRun(recovered.at(-1)!);
    expect(reviews.runDetail('history-000').post.status).not.toBe('unknown');
    expect(reviews.recoveryRuns().runs.every(run => run.id !== 'history-000')).toBe(true);
  } finally { store.close(); reviews.close(); }
});

test('invalidates only the pull request whose review history changed', async () => {
  const { reviews, directory } = harness();
  const repository = await connect(reviews, {});
  seedHistory(directory, repository.id, 1, 'Synthetic review');
  const store = new PullRequestReviewStore(directory);
  try {
    const before = reviews.snapshot().inbox[0].historyRevision;
    store.recordScan(repository.id, { status: 'ok', scannedAt: new Date().toISOString(), message: null }, [pull()]);
    expect(reviews.snapshot().inbox[0].historyRevision).toBe(before);
    store.updateRun('history-000', run => ({ ...run, post: { ...run.post, status: 'posted' } }));
    expect(reviews.snapshot().inbox[0].historyRevision).toBe(before + 1);
    expect(reviews.runs(repository.id, 7).revision).toBe(before + 1);
  } finally { store.close(); reviews.close(); }
});

test('keeps history pages in newest insertion order when run timestamps tie', async () => {
  const { reviews, directory } = harness();
  const repository = await connect(reviews, {});
  seedHistory(directory, repository.id, 21, 'Synthetic review');
  const database = new Database(join(directory, 'pull-request-reviews.sqlite'));
  try { database.query("UPDATE review_runs SET created_at = '2026-01-01T00:00:00.000Z'").run(); }
  finally { database.close(); }
  const first = reviews.runs(repository.id, 7);
  expect(first.runs[0].id).toBe(reviews.snapshot().inbox[0].latestRun?.id);
  expect(first.runs[0].id).toBe('history-020');
  const [createdAt, sequence] = JSON.parse(first.nextCursor!);
  expect(reviews.runs(repository.id, 7, { createdAt, sequence }).runs.map(run => run.id)).toEqual(['history-000']);
  reviews.close();
});

test('starts Enterprise reviews with code links to the saved repository host', async () => {
  const { reviews, deps, starts, turns, github } = harness();
  const gh = await deps.executors.requireExecutor('local').getGhService();
  const list = spyOn(gh, 'listPullRequests');
  list.mockResolvedValue({ executorId: 'local', instanceId: 'instance', pulls: github.pulls,
    repo: { nameWithOwner: 'acme/app', url: 'https://git.example.invalid/acme/app' }, viewerLogin: 'viewer' });
  try {
    await connect(reviews, { autoReview: true });
    reviews.start();
    await until(() => turns.has('chat-1'));
    expect(starts[0].command).toContain('https://git.example.invalid/acme/app/blob/');
    expect(starts[0].command).not.toContain('github.com');
  } finally { list.mockRestore(); reviews.close(); }
});

test('reviews a new pull request automatically and posts the review as a comment', async () => {
  const { reviews, github, turns, starts } = harness();
  await connect(reviews, { autoReview: true, autoPost: true });
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

test('invalidates a completed review immediately when its chat is deleted', async () => {
  const { reviews, deps, turns } = harness();
  const repository = await connect(reviews, {});
  const invalidated = spyOn(deps, 'onInvalidated');
  try {
    reviews.start();
    reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    turns.get('chat-1')!(`No findings.\n\nReviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'completed');
    await Promise.resolve();
    const before = reviews.snapshot();
    expect(before.inbox[0].latestRun?.chatAvailable).toBe(true);
    invalidated.mockClear();

    deps.chats.hasChat = () => false;
    reviews.handleChatRemoved('chat-1');
    await until(() => invalidated.mock.calls.length > 0);

    const after = reviews.snapshot();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(invalidated).toHaveBeenCalledWith(after.revision);
    expect(after.inbox[0].latestRun).toMatchObject({ state: 'completed', chatId: null, chatAvailable: false });
    expect(reviews.runDetail(before.inbox[0].latestRun!.id)).toMatchObject({
      chatId: null, chatAvailable: false, review: `No findings.\n\nReviewed commit: ${HEAD}`,
    });

    invalidated.mockClear();
    reviews.handleChatRemoved('unrelated-chat');
    reviews.handleChatRemoved('chat-1');
    await Promise.resolve();
    expect(invalidated).not.toHaveBeenCalled();
    expect(reviews.snapshot().revision).toBe(after.revision);
  } finally { invalidated.mockRestore(); reviews.stop(); reviews.close(); }
});

test('tracks a permission committed before startup returns and arms its timeout', async () => {
  const { reviews, deps, turns } = harness(undefined, () => Date.parse('2026-10-17T12:00:00Z'));
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

test('gives an overlapping permission its own timeout after the older request resolves', async () => {
  const minute = 60_000;
  const startedAt = Date.parse('2026-10-17T12:00:00Z');
  let now = startedAt;
  const { reviews, deps, turns } = harness(undefined, () => now);
  const repository = await connect(reviews, { autoPost: true });
  const stop = spyOn(deps.commands, 'submitStop');
  const scheduled = new Map<ReturnType<typeof setTimeout>, { at: number; fire(): void }>();
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay = 0, ...args) => {
    const handle = schedule(() => {}, 30 * minute);
    handle.unref?.();
    scheduled.set(handle, { at: now + delay, fire: () => callback(...args) });
    return handle;
  });
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
    if (handle) scheduled.delete(handle);
    cancel(handle);
  });
  const advance = (minutes: number) => {
    now = startedAt + minutes * minute;
    for (const [handle, task] of [...scheduled]) {
      if (task.at > now) continue;
      clearTimeout(handle);
      task.fire();
    }
  };
  const viewId = transcriptViewId('synthetic-view');
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const request = (permissionOccurrenceId: string, ordinal: number) => reviews.handleTranscriptCommit({
    type: 'permission', chatId: 'chat-1', runId: 'run', viewId,
    row: { kind: 'permission-requested', viewId, ordinal, at: '', providerMeta: null,
      lifecycle: { kind: 'requested', permissionOccurrenceId, requestedTool: new BashToolUseMessage('', 'tool', 'pwd'), options: [] } },
  });
  reviews.start();
  try {
    reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    request(first, 1);
    advance(20);
    request(second, 2);
    advance(21);
    reviews.handleTranscriptCommit({
      type: 'permission', chatId: 'chat-1', runId: 'run', viewId,
      row: { kind: 'permission-resolved', viewId, ordinal: 3, at: '', providerMeta: null,
        lifecycle: { kind: 'resolved', permissionOccurrenceId: first, decision: { allow: true } } },
    });
    advance(30);
    expect(stop).not.toHaveBeenCalled();
    expect(latestRun(reviews)?.state).toBe('needs-input');
    advance(49);
    expect(stop).not.toHaveBeenCalled();
    advance(50);
    await until(() => stop.mock.calls.length === 1);
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'failed');
    expect(latestRun(reviews)?.post.status).toBe('none');
  } finally {
    reviews.stop();
    reviews.close();
    timer.mockRestore();
    clear.mockRestore();
    stop.mockRestore();
  }
});

test('surfaces a resolved failed stop and permits a fresh manual retry', async () => {
  const { reviews, deps, turns } = harness();
  const repository = await connect(reviews, {});
  const stop = spyOn(deps.commands, 'submitStop');
  stop.mockResolvedValueOnce({ success: true, commandType: 'chat-stop', clientRequestId: 'stop', status: 'accepted', acceptedAt: '', outcome: 'failed', control: emptyChatExecutionControlState('instance') });
  reviews.start();
  try {
    const run = reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    await expect(reviews.stopRun(run.id)).rejects.toThrow('could not be stopped');
    expect(latestRun(reviews)?.state).toBe('reviewing');
    await reviews.stopRun(run.id);
    expect(stop.mock.calls[0][0].clientRequestId).not.toBe(stop.mock.calls[1][0].clientRequestId);
  } finally { stop.mockRestore(); reviews.stop(); reviews.close(); }
});

for (const failure of ['failed-outcome', 'throw'] as const) {
  test(`retries permission-timeout Stop after ${failure} with a fresh identity until terminal`, async () => {
    const { reviews, deps, turns } = harness(undefined, () => Date.parse('2026-10-17T12:00:00Z'));
    const repository = await connect(reviews, { autoPost: true });
    const stop = spyOn(deps.commands, 'submitStop');
    if (failure === 'throw') stop.mockRejectedValueOnce(new Error('Executor unavailable'));
    else stop.mockResolvedValueOnce({ success: true, commandType: 'chat-stop', clientRequestId: 'stop', status: 'accepted', acceptedAt: '', outcome: 'failed', control: emptyChatExecutionControlState('instance') });
    const timer = spyOn(globalThis, 'setTimeout');
    reviews.start();
    try {
      reviews.review(repository.id, 7);
      await until(() => turns.has('chat-1'));
      const viewId = transcriptViewId('synthetic-view');
      reviews.handleTranscriptCommit({
        type: 'permission', chatId: 'chat-1', runId: 'native-run', viewId,
        row: { kind: 'permission-requested', viewId, ordinal: 1, at: '', providerMeta: null,
          lifecycle: { kind: 'requested', permissionOccurrenceId: '11111111-1111-4111-8111-111111111111', requestedTool: new BashToolUseMessage('', 'tool', 'pwd'), options: [] } },
      });
      const expire = timer.mock.calls.find((call) => call[1] === 30 * 60_000)![0] as () => void;
      expire();
      await until(() => stop.mock.calls.length === 1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(latestRun(reviews)?.message).toContain('could not be stopped');
      const retry = timer.mock.calls.findLast((call) => call[1] === 30_000)?.[0] as (() => void) | undefined;
      expect(retry).toBeDefined();
      retry!();
      await until(() => stop.mock.calls.length === 2);
      expect(stop.mock.calls[0][0].clientRequestId).not.toBe(stop.mock.calls[1][0].clientRequestId);
      turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
      await until(() => latestRun(reviews)?.state === 'failed');
      expect(latestRun(reviews)?.post.status).toBe('none');
      const calls = stop.mock.calls.length;
      retry!();
      await new Promise((resolve) => setImmediate(resolve));
      expect(stop).toHaveBeenCalledTimes(calls);
    } finally { timer.mockRestore(); stop.mockRestore(); reviews.stop(); reviews.close(); }
  });
}

test('retains a repository and its review while a comment is being delivered', async () => {
  const { reviews, deps, turns, github } = harness();
  github.pulls.push(pull({ number: 8 }));
  const repository = await connect(reviews, {});
  const gh = await deps.executors.requireExecutor().getGhService();
  const create = spyOn(gh, 'createPullRequestComment');
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof gh.createPullRequestComment>>>();
  create.mockImplementationOnce(() => pending.promise);
  reviews.start();
  try {
    const run = reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'completed');
    const posting = reviews.postRun(run.id);
    await until(() => create.mock.calls.length === 1);
    expect(() => reviews.remove(repository.id)).toThrow('being posted');
    await expect(reviews.update(repository.id, {
      target: { ...repository.target, executorId: '11111111-1111-4111-8111-111111111111' }, settings: repository.settings,
    })).rejects.toThrow('being posted');
    expect(reviews.snapshot().repositories[0].target).toEqual(repository.target);
    expect(reviews.runs(repository.id, 7).runs).toHaveLength(1);
    await expect(reviews.postRun(run.id)).rejects.toThrow('already being posted');
    const another = reviews.review(repository.id, 8);
    await until(() => turns.has('chat-2'));
    turns.get('chat-2')!(`Reviewed commit: ${HEAD}`);
    await until(() => reviews.runs(repository.id, 8).runs[0]?.state === 'completed');
    await expect(reviews.postRun(another.id)).resolves.toMatchObject({ post: { status: 'posted' } });
    expect(() => reviews.remove(repository.id)).toThrow('being posted');
    pending.resolve({ executorId: 'local', instanceId: 'instance', id: 'comment', url: 'https://git.example.invalid/comment' });
    await expect(posting).resolves.toMatchObject({ post: { status: 'posted' } });
    reviews.remove(repository.id);
    expect(reviews.snapshot().repositories).toEqual([]);
  } finally { create.mockRestore(); reviews.stop(); reviews.close(); }
});

test('keeps an unknown post on its original executor until reconciliation', async () => {
  const { reviews, deps, turns } = harness();
  const repository = await connect(reviews, {});
  const gh = await deps.executors.requireExecutor().getGhService();
  const create = spyOn(gh, 'createPullRequestComment');
  create.mockRejectedValueOnce(new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Reply lost'));
  reviews.start();
  try {
    const run = reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'completed');
    await reviews.postRun(run.id);
    await expect(reviews.update(repository.id, {
      target: { ...repository.target, projectPath: '/work/other' }, settings: repository.settings,
    })).rejects.toThrow('unconfirmed post');
    await expect(reviews.update(repository.id, {
      target: repository.target, settings: { ...repository.settings, autoPost: false },
    })).resolves.toMatchObject({ settings: { autoPost: false } });
    expect(() => reviews.remove(repository.id)).toThrow('unconfirmed post');
    expect(reviews.runs(repository.id, 7).runs[0]).toMatchObject({ id: run.id, post: { status: 'unknown' } });
    await expect(reviews.postRun(run.id)).resolves.toMatchObject({ post: { status: 'posted' } });
    reviews.remove(repository.id);
    expect(reviews.snapshot().repositories).toEqual([]);
  } finally { create.mockRestore(); reviews.stop(); reviews.close(); }
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
  const run = store.runsForPull(repository.id, 7).runs[0];
  expect(run.chatArchived).toBe(false);
  service.scan(repository.id);
  await until(() => store.getRun(run.id)?.chatArchived === true);
  expect(attempts).toBe(2);
  service.stop(); service.close();
});

test('keeps an unpublished review until it is posted, and refuses to post after new commits', async () => {
  const { reviews, github, turns } = harness();
  const repository = await connect(reviews, { autoPost: false });
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

test('keeps reviews unpublished by default and allows an explicit manual post', async () => {
  const { reviews, github, turns } = harness();
  const repository = await connect(reviews, {});
  reviews.start();
  try {
    const run = reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'completed');
    expect(latestRun(reviews)?.post.status).toBe('none');
    expect(github.comments).toEqual([]);
    await reviews.postRun(run.id);
    expect(latestRun(reviews)?.post.status).toBe('posted');
    expect(github.comments).toHaveLength(1);
  } finally { reviews.stop(); reviews.close(); }
});

test('does not automatically post when the repository checkbox is cleared during a review', async () => {
  const { reviews, github, turns } = harness();
  const repository = await connect(reviews, { autoPost: true });
  reviews.start();
  try {
    reviews.review(repository.id, 7);
    await until(() => turns.has('chat-1'));
    await reviews.update(repository.id, { target: repository.target, settings: { ...repository.settings, autoPost: false } });
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => latestRun(reviews)?.state === 'completed');
    expect(latestRun(reviews)?.post.status).toBe('none');
    expect(github.comments).toEqual([]);
  } finally { reviews.stop(); reviews.close(); }
});

test('fails a review whose response names no commit', async () => {
  const { reviews, turns } = harness();
  const repository = await connect(reviews, {});
  reviews.start();
  reviews.review(repository.id, 7);
  await until(() => turns.has('chat-1'));
  turns.get('chat-1')!('Looks fine.');
  await until(() => latestRun(reviews)?.state === 'failed');
  expect(reviews.runDetail(reviews.runs(repository.id, 7).runs[0].id)).toMatchObject({ message: 'The review does not name the commit it reviewed.', review: 'Looks fine.' });
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
    expect(reopened.reviews.runDetail(run.id)).toMatchObject({ id: run.id, state: 'completed', review: text });
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
    expect(reviews.runs(local.id, 8).runs[0]).toMatchObject({ id: queued.id, state: 'queued', chatId: null });
    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => starts.length === 3);
    expect(reviews.runs(local.id, 7).runs[0]).toMatchObject({ id: first.id, state: 'completed' });
    expect(reviews.runs(local.id, 8).runs[0]).toMatchObject({ id: queued.id, state: 'reviewing', chatId: 'chat-3' });
  } finally { reviews.stop(); reviews.close(); }
});

test('posts a review of the live head even when the scanner cached the preceding head', async () => {
  const { reviews, github, turns } = harness();
  const repository = await connect(reviews, { autoPost: true });
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
    await until(() => reviews.runs(repository.id, 8).runs.length === 1);
    expect(reviews.runs(repository.id, 7).runs).toMatchObject([{ state: 'reviewing', headSha: HEAD }]);
    expect(reviews.runs(repository.id, 8).runs).toMatchObject([{ state: 'queued' }]);
    expect(starts).toHaveLength(1);

    turns.get('chat-1')!(`Reviewed commit: ${HEAD}`);
    await until(() => turns.has('chat-2'));
    reviews.scan(repository.id);
    await until(() => reviews.runs(repository.id, 7).runs.length === 2);
    expect(reviews.runs(repository.id, 7).runs).toMatchObject([
      { state: 'queued', headSha: nextHead }, { state: 'outdated', reviewedSha: HEAD },
    ]);
  } finally { reviews.stop(); reviews.close(); }
});

test('allows disabling reviews and automatic posting while the preserved executor is offline', async () => {
  const { reviews, deps } = harness();
  const repository = await connect(reviews, { autoReview: true, autoPost: true });
  deps.agents.assertExecutorReady = () => { throw new Error('Executor offline'); };
  const updated = await reviews.update(repository.id, {
    target: repository.target,
    settings: { ...repository.settings, autoReview: false, autoPost: false },
  });
  expect(updated.settings).toMatchObject({ autoReview: false, autoPost: false });
  await expect(reviews.update(repository.id, {
    target: { ...repository.target, projectPath: '/work/other' }, settings: updated.settings,
  })).rejects.toThrow('Executor offline');
  reviews.close();
});

test('preserves a validated literal prompt when changing settings after a cold offline restart', async () => {
  const first = harness();
  first.deps.agents.executionPolicy = () => 'literal';
  const repository = await first.reviews.connect({
    target: { ...target, agentId: 'shell', executorId: '11111111-1111-4111-8111-111111111111' },
    settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, prompt: '/review', autoReview: true, autoPost: true },
  });
  first.reviews.close();
  first.deps.agents.assertExecutorReady = () => { throw new Error('Executor offline'); };
  const policy = spyOn(first.deps.agents, 'executionPolicy').mockImplementation(() => { throw new Error('Unknown offline integration'); });
  const store = new PullRequestReviewStore(first.directory);
  const restarted = new PullRequestReviews(store, first.deps);
  try {
    const updated = await restarted.update(repository.id, {
      target: repository.target,
      settings: { ...repository.settings, autoReview: false, autoPost: false },
    });
    expect(updated.settings).toMatchObject({ prompt: '/review', autoReview: false, autoPost: false });
    expect(policy).not.toHaveBeenCalled();
    await expect(restarted.update(repository.id, {
      target: repository.target, settings: { ...updated.settings, prompt: '/other-review' },
    })).rejects.toThrow('Unknown offline integration');
  } finally { policy.mockRestore(); restarted.stop(); restarted.close(); }
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

test('refuses to move a connection to a checkout with the same repository name on another host', async () => {
  const { reviews, deps } = harness();
  const repository = await connect(reviews, {});
  const gh = await deps.executors.requireExecutor().getGhService();
  const result = await gh.listPullRequests();
  const read = spyOn(gh, 'listPullRequests').mockResolvedValue({
    ...result, repo: { nameWithOwner: repository.nameWithOwner, url: 'https://git.example.invalid/acme/app' },
  });
  try {
    await expect(reviews.update(repository.id, {
      target: { ...repository.target, projectPath: '/work/other' }, settings: repository.settings,
    })).rejects.toThrow('not a checkout');
    expect(reviews.snapshot().repositories[0].target).toEqual(repository.target);
  } finally { read.mockRestore(); reviews.close(); }
});

test('serializes concurrent connects at the repository limit', async () => {
  const { reviews, directory } = harness();
  const database = new Database(join(directory, 'pull-request-reviews.sqlite'));
  try {
    database.transaction(() => {
      const insert = database.query('INSERT INTO review_repositories VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (let index = 0; index < PULL_REQUEST_REVIEW_MAX_REPOSITORIES - 1; index++) {
        const repository = { id: `seed-${index}`, nameWithOwner: `acme/seed-${index}`, target, settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, viewerLogin: 'viewer', url: `https://github.com/acme/seed-${index}`, createdAt: '', updatedAt: '' };
        insert.run(repository.id, JSON.stringify(repository), JSON.stringify({ status: 'ok', scannedAt: null, message: null }), '[]', 'local', 'github.com', repository.nameWithOwner);
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
