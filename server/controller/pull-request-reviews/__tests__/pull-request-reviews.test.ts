import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, type PullRequestReviewSettings } from '../../../../common/pull-request-reviews.js';
import type { PullRequestSummary } from '../../../../common/gh.js';
import { PullRequestReviews, type PullRequestReviewsDeps } from '../setup.js';
import { PullRequestReviewStore } from '../store.js';

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
    agents: { hasAgent: () => true, assertExecutorReady() {}, assertExecutionModeSelectionSupported() {}, executionPolicy: () => 'conversation' },
    chats: { hasChat: () => true },
    commands: {
      async submitScheduledStart(input: { chatId: string; command: string; tags: string[] }) {
        starts.push(input);
        return { chatId: input.chatId, turnId: `turn-${input.chatId}` };
      },
      async submitStop() { return {}; },
    },
    chatIds: { allocate: () => `chat-${++chatCount}` },
    turns: {
      waitForTurnTerminal: (chatId: string, turnId: string) => new Promise((resolve) => {
        turns.set(chatId, (text) => resolve({
          chatId, turnId, clientRequestId: 'request', acceptedAt: '', updatedAt: '', publicTerminalAt: '2026-01-01T00:00:00Z',
          status: 'finished', turnResult: { availability: 'available', text, bytes: text.length },
        }));
      }),
    },
    chatNames: { setSessionName: async () => ({}) },
    archiveChat: async () => {},
    onInvalidated() {},
  } as unknown as PullRequestReviewsDeps;
  const reviews = new PullRequestReviews(new PullRequestReviewStore(directory), deps);
  return { reviews, github, turns, starts, directory };
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
