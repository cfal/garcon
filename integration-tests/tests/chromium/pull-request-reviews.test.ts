import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  type PullRequestReviewsSnapshot,
} from '../../../common/pull-request-reviews.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

const HEAD = '3f9c2ab41d6e0c7b8a5f2e1d9c4b3a2f1e0d9c8b';

// Synthetic pull requests covering each inbox group and review state.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const PULLS = [
  { number: 128, title: 'Keep queue controls stable during reconnect', author: { login: 'author-one', __typename: 'User' }, reviewRequests: ['synthetic-viewer'], checks: 'SUCCESS', additions: 1465, deletions: 599, headRefOid: HEAD, headRefName: 'fix/queue', createdAt: minutesAgo(26), updatedAt: minutesAgo(20) },
  { number: 131, title: 'Add search to the project picker', author: { login: 'author-two', __typename: 'User' }, reviewRequests: ['synthetic-viewer'], checks: 'PENDING', headRefName: 'feat/picker-search', createdAt: minutesAgo(130), updatedAt: minutesAgo(90) },
  { number: 133, title: 'Document executor reconnect limits', author: { login: 'synthetic-viewer', __typename: 'User' }, checks: 'SUCCESS', headRefName: 'docs/reconnect', createdAt: minutesAgo(300), updatedAt: minutesAgo(240) },
  { number: 135, title: 'Speed up transcript paging', author: { login: 'author-three', __typename: 'User' }, teamReviewRequested: true, checks: 'FAILURE', headRefName: 'perf/paging', createdAt: minutesAgo(1500), updatedAt: minutesAgo(600) },
  { number: 136, title: 'Bump synthetic dependencies', author: { login: 'synthetic-bot', __typename: 'Bot' }, headRefName: 'deps/bump', createdAt: minutesAgo(2900), updatedAt: minutesAgo(2800) },
];

// The shell agent prints this as its final response; #131 keeps reviewing.
const REVIEW_SCRIPT = `#!/bin/sh
if [ "$1" = 131 ]; then sleep 600; fi
if [ "$1" != 128 ]; then printf 'No actionable findings.\\n\\nReviewed commit: %s\\n' "$2"; exit 0; fi
cat <<'REVIEW'
### High

**Queue pause is lost on reconnect.** [src/queue.ts L88-L104](https://git.example.invalid/acme/app/blob/${HEAD}/src/queue.ts#L88-L104) restores the queue from the server snapshot after a reconnect but drops the local paused flag, so a paused queue resumes sending. Carry the flag through \`restoreQueue\` and add a reconnect case to the queue tests.

### Medium

**No test covers the replaced session.** [test/session.test.ts L40](https://git.example.invalid/acme/app/blob/${HEAD}/test/session.test.ts#L40) only exercises the first session; a replacement session takes a different branch in \`resumeBindings\`.

Reviewed commit: ${HEAD}
REVIEW
`;

test('reviews pull requests in chats and shows them in the GitHub Views inbox', async () => {
  await withChromiumFixture('pull-request-reviews', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, dirs } = integration;
    const project = dirs.project;
    await initializeFixtureRepository(project);
    await writeFile(join(project, 'review.sh'), REVIEW_SCRIPT);
    const screenshots = process.env.GARCON_SCREENSHOT_DIR;
    if (screenshots) await mkdir(screenshots, { recursive: true });
    const capture = async (name: string) => {
      if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) });
    };

    phase('open Pull Requests from GitHub Views before connecting');
    // Wide enough for the inbox list and detail to stay side by side next to the review chat.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(integration.garcon.baseUrl);
    await page.locator('[data-workspace-window-add-group-trigger="github-views"]').first().waitFor({ timeout: 30_000 });
    await collapseCanonicalFilesWindow(page);
    await page.locator('[data-workspace-window-add-group-trigger="github-views"]').first().click();
    await page.locator('[data-workspace-window-group-menu="github-views"]').getByRole('menuitem', { name: 'Open Pull Requests' }).waitFor();
    await capture('github-views-menu');
    await page.keyboard.press('Escape');
    await clickWorkspaceWindowAddAction(page, 'Open Pull Requests');
    const panel = page.locator('[data-workspace-surface-id="singleton:pull-requests"][aria-hidden="false"]');
    await panel.locator('[data-pr-inbox-empty]').waitFor();
    await capture('inbox-empty-desktop');
    await panel.locator('[data-pr-inbox-connect]').click();
    const connectForm = page.locator('[data-pr-repository-dialog]');
    await connectForm.getByText('Review automatically', { exact: true }).waitFor();
    // Review prompts offer their own tokens, not the scheduled-prompt chat ID.
    await browserExpect(connectForm.getByRole('button', { name: 'Insert {{pull_request_number}}' })).toBeVisible();
    await browserExpect(connectForm.getByRole('button', { name: 'Insert {{chat_id}}' })).toHaveCount(0);
    await capture('connect-repository-desktop');
    await page.keyboard.press('Escape');
    await browserExpect(connectForm).toHaveCount(0);

    phase('connect the repository with automatic review');
    await client.post('/api/v1/pull-request-reviews/repositories', {
      target: {
        type: 'new-chat', agentId: 'shell', model: 'sh', projectPath: project, apiProviderId: null, modelEndpointId: null,
        modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
        agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' },
      },
      settings: {
        ...DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, autoReview: true, debounceMinutes: 0,
        prompt: `sh ./review.sh {{pull_request_number}} ${HEAD}`,
      },
    });
    const deadline = Date.now() + 30_000;
    let snapshot = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
    while (!snapshot.inbox.some((entry) => entry.pull.number === 131 && entry.latestRun?.state === 'reviewing') && Date.now() < deadline) {
      await Bun.sleep(200);
      snapshot = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
    }
    expect(snapshot.inbox.find((entry) => entry.pull.number === 128)?.latestRun).toMatchObject({ state: 'completed', reviewedSha: HEAD });

    phase('the inbox fills in once the repository is connected');
    const needsReview = panel.locator('[data-pr-inbox-group="needs-my-review"]');
    await browserExpect(needsReview.locator('[data-pr-inbox-row]')).toHaveCount(2);
    await browserExpect(needsReview.locator('[data-pr-inbox-row="' + snapshot.repositories[0].id + '#131"]')).toContainText('Reviewing');
    await browserExpect(panel.locator('[data-pr-inbox-group="authored-by-me"]')).toContainText('Document executor reconnect limits');
    await browserExpect(panel.locator('[data-pr-inbox-group="needs-team-review"]')).toContainText('Speed up transcript paging');
    await browserExpect(panel.locator('[data-pr-inbox-group="other-open"] [data-pr-inbox-row]')).toHaveCount(1);
    await browserExpect(panel.locator('[data-pr-inbox-group="other-open"]')).toContainText('Skipped: bot author');

    phase('select a reviewed pull request');
    await needsReview.getByText('Keep queue controls stable during reconnect').click();
    await panel.locator('[data-pr-review-tab]').getByText('Queue pause is lost on reconnect.').waitFor();
    await browserExpect(panel.getByRole('button', { name: 'Post to GitHub' })).toBeVisible();
    // Desktop shows the review chat beside the inbox.
    await page.locator('[data-workspace-surface-id^="chat-view:"]').getByText('Reviewed commit:', { exact: false }).last().waitFor();
    await capture('inbox-review-desktop');

    phase('changes and checks');
    await panel.locator('[data-pr-tab="changes"]').click();
    await panel.locator('[data-pr-detail]').getByText('example.txt').first().waitFor();
    await capture('inbox-changes-desktop');
    await panel.locator('[data-pr-tab="checks"]').click();
    await panel.getByText('Unit tests', { exact: true }).waitFor();
    await browserExpect(panel.locator('[data-pr-checks-summary]')).toHaveText('2 passed');
    await capture('inbox-checks-desktop');

    phase('repositories');
    await panel.locator('[data-pr-repositories-button]').click();
    const repositories = page.locator('[data-pr-repositories-dialog]');
    await repositories.locator('[data-pr-repository="acme/app"]').waitFor();
    await browserExpect(repositories.locator('[data-pr-run-log]')).toContainText('acme/app #128');
    await capture('repositories-desktop');
    await page.keyboard.press('Escape');

    phase('mobile inbox');
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(panel.locator('[data-pr-repositories-button]')).toBeVisible();
    await capture('inbox-detail-mobile');
    await panel.locator('[data-pr-repositories-button]').click();
    await page.locator('[data-pr-repositories-dialog]').waitFor();
    await page.keyboard.press('Escape');
    await panel.getByRole('button', { name: 'All pull requests' }).click();
    await browserExpect(needsReview).toBeVisible();
    await capture('inbox-mobile');
    assertNoBrowserErrors();
  }, undefined, {
    executionBackend: 'in-process',
    resolveServerEnvironment: dirs => ({ PATH: `${join(dirs.root, 'gh-bin')}:${process.env.PATH}` }),
    prepareWorkspace: async dirs => {
      const bin = join(dirs.root, 'gh-bin');
      await mkdir(bin);
      await copyFile(new URL('../../../server/remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
      await chmod(join(bin, 'gh'), 0o755);
      await symlink(process.execPath, join(bin, 'bun'));
      await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({
        label: 'synthetic-viewer', owner: 'acme', repository: 'app', pulls: PULLS,
        statusChecks: [
          { __typename: 'CheckRun', name: 'Unit tests', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://git.example.invalid/acme/app/actions/unit-tests' },
          { __typename: 'CheckRun', name: 'Type check', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://git.example.invalid/acme/app/actions/type-check' },
        ],
      }));
    },
  });
}, 180_000);
