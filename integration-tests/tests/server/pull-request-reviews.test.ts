import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  type PullRequestReviewMutationResponse,
  type PullRequestReviewRun,
  type PullRequestReviewsSnapshot,
} from '../../../common/pull-request-reviews.js';
import { withIntegrationFixture, type IntegrationFixture } from '../../support/integration-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

async function latestRun(fixture: IntegrationFixture, until: (run: PullRequestReviewRun | null) => boolean, number = 7): Promise<PullRequestReviewRun | null> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await fixture.client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
    const run = snapshot.inbox.find((entry) => entry.pull.number === number)?.latestRun ?? null;
    if (until(run) || Date.now() > deadline) return run;
    await Bun.sleep(100);
  }
}

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`reviews a pull request in a chat and posts it once through the executor's gh (${executionBackend})`, async () => {
    await withIntegrationFixture(`pull-request-reviews-${executionBackend}`, async fixture => {
      const executorId = fixture.client.executorId;
      const project = fixture.executionDirs.project;
      await initializeFixtureRepository(project);
      const fixturePath = join(project, 'gh-fixture.json');
      await writeFile(fixturePath, JSON.stringify({
        label: 'synthetic-worker', commentResponse: '{',
        pulls: [{ number: 7, headRefOid: HEAD, reviewRequests: ['synthetic-worker'] }],
      }));

      // The shell agent's output is its final response, so the "review" is deterministic.
      const connected = await fixture.client.post<PullRequestReviewMutationResponse>('/api/v1/pull-request-reviews/repositories', {
        target: {
          type: 'new-chat', ...(executorId === 'local' ? {} : { executorId }), agentId: 'shell', model: 'sh', projectPath: project,
          apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
          agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' },
        },
        settings: { ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoPost: true, prompt: `printf 'No findings.\\n\\nReviewed commit: ${HEAD}\\n'` },
      });
      const [repository] = connected.snapshot.repositories;
      expect(repository).toMatchObject({ nameWithOwner: 'synthetic-worker/repository', viewerLogin: 'synthetic-worker', scan: { status: 'ok' } });
      expect(connected.snapshot.inbox.map((entry) => [entry.pull.number, entry.pull.reviewRequest])).toEqual([[7, 'me']]);

      await fixture.client.post('/api/v1/pull-request-reviews/runs', { repositoryId: repository.id, number: 7 });
      const unconfirmed = await latestRun(fixture, (run) => run?.post.status === 'unknown' && Boolean(run.post.message?.includes('Post again'))
        || run?.post.status === 'failed' || run?.state === 'failed');
      expect(unconfirmed).toMatchObject({ state: 'completed', reviewedSha: HEAD, post: { status: 'unknown' } });
      expect(unconfirmed!.post.actor?.id).toBeString();
      await writeFile(fixturePath, JSON.stringify({
        label: 'synthetic-worker', login: 'other-viewer', commentResponse: '{',
        pulls: [{ number: 7, headRefOid: HEAD }],
      }));
      await fixture.client.post('/api/v1/pull-request-reviews/runs/post', { runId: unconfirmed!.id });
      const switched = await latestRun(fixture, () => true);
      expect(switched?.post).toMatchObject({ status: 'posted', actor: unconfirmed!.post.actor });
      expect(JSON.parse(await readFile(join(project, 'gh-comments.json'), 'utf8'))).toHaveLength(1);
      await writeFile(fixturePath, JSON.stringify({
        label: 'synthetic-worker', commentResponse: '{', pulls: [{ number: 7, headRefOid: HEAD }],
      }));
      await fixture.client.post('/api/v1/pull-request-reviews/runs/post', { runId: unconfirmed!.id });
      const posted = await latestRun(fixture, (run) => run?.post.status === 'posted' || run?.state === 'failed');
      expect(posted).toMatchObject({ state: 'completed', reviewedSha: HEAD, chatAvailable: true, post: { status: 'posted' } });
      const comments = JSON.parse(await readFile(join(project, 'gh-comments.json'), 'utf8')) as { id: string; url: string; number: number; body: string }[];
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        id: 'comment-1', url: expect.any(String), number: 7,
        body: `No findings.\n\nReviewed commit: ${HEAD}\n\n<!-- garcon-review synthetic-worker/repository#7 ${HEAD} -->`,
      });
      const { run: stored } = await fixture.client.get<{ run: { review: string } }>(
        `/api/v1/pull-request-reviews/runs/detail?runId=${posted!.id}`,
      );
      expect(stored.review).toBe(`No findings.\n\nReviewed commit: ${HEAD}\n`);

      await writeFile(fixturePath, JSON.stringify({ label: 'synthetic-worker', pulls: [{ number: 7, headRefOid: NEXT_HEAD }] }));
      await fixture.client.post('/api/v1/pull-request-reviews/scan', { repositoryId: repository.id });
      expect(await latestRun(fixture, (run) => run?.state === 'outdated')).toMatchObject({ state: 'outdated', post: { status: 'posted' } });

      // A file barrier keeps the next review active across a push and scan.
      await fixture.client.put('/api/v1/pull-request-reviews/repositories', {
        id: repository.id,
        repository: {
          target: repository.target,
          settings: {
            ...repository.settings, autoReview: true, debounceMinutes: 0, autoPost: false,
            prompt: `while [ ! -f review-release ]; do sleep 0.05; done\nprintf 'Reviewed commit: ${NEXT_HEAD}\\n'`,
          },
        },
      });
      const running = await latestRun(fixture, (run) => run?.state === 'reviewing');
      expect(running).toMatchObject({ state: 'reviewing', headSha: NEXT_HEAD });
      const pushedHead = 'c'.repeat(40);
      await writeFile(fixturePath, JSON.stringify({ label: 'synthetic-worker', pulls: [
        { number: 7, headRefOid: pushedHead }, { number: 8, headRefOid: NEXT_HEAD },
      ] }));
      await fixture.client.post('/api/v1/pull-request-reviews/scan', { repositoryId: repository.id });
      expect(await latestRun(fixture, (run) => run !== null, 8)).toMatchObject({ state: 'queued', chatId: null });
      expect(await latestRun(fixture, () => true)).toMatchObject({ id: running!.id, state: 'reviewing' });
      await writeFile(join(project, 'review-release'), 'ready');
      expect(await latestRun(fixture, (run) => run?.state === 'completed', 8)).toMatchObject({ state: 'completed' });
    }, {
      executionBackend, projectRoots: 'separate',
      resolveServerEnvironment: dirs => ({ PATH: `${join(dirs.root, 'gh-bin')}:${process.env.PATH}` }),
      prepareWorkspace: async dirs => {
        const bin = join(dirs.root, 'gh-bin');
        await mkdir(bin);
        await copyFile(new URL('../../../server/remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
        await chmod(join(bin, 'gh'), 0o755);
        await symlink(process.execPath, join(bin, 'bun'));
      },
    });
  }, 90_000);
}
