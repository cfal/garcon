import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  type PullRequestReviewRunMutationResponse,
  type PullRequestReviewRunsResponse,
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
  { number: 133, title: 'Document executor reconnect limits', author: { login: 'synthetic-viewer', __typename: 'User' }, checks: 'SUCCESS', headRefOid: HEAD, headRefName: 'docs/reconnect', createdAt: minutesAgo(300), updatedAt: minutesAgo(240) },
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
  await withChromiumFixture('pull-request-reviews', async ({ page, integration, browserErrors }, phase) => {
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
    await connectForm.getByRole('button', { name: 'Insert variable', exact: true }).click();
    await browserExpect(page.getByRole('menuitem', { name: /\{\{pull_request_number\}\}/ })).toBeVisible();
    await browserExpect(page.getByRole('menuitem', { name: /\{\{repository_url\}\}/ })).toBeVisible();
    await browserExpect(page.getByRole('menuitem', { name: /\{\{chat_id\}\}/ })).toHaveCount(0);
    await browserExpect(page.getByRole('menuitem', { name: /\{\{current_date\}\}/ })).toHaveCount(0);
    await capture('review-prompt-variables-desktop');
    await page.keyboard.press('Escape');
    await browserExpect(connectForm.getByRole('checkbox', { name: 'Post reviews to GitHub automatically' })).not.toBeChecked();
    await browserExpect(connectForm.getByRole('checkbox', { name: 'Skip bot authors' })).toHaveCount(0);
    await browserExpect(connectForm.getByRole('checkbox', { name: 'Include pull requests from forks' })).toHaveCount(0);
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
    await browserExpect(panel.locator('[data-pr-inbox-group="other-open"]')).toContainText('Queued');

    phase('select a reviewed pull request');
    const historyRead = Promise.withResolvers<void>();
    let rejectHistory = true;
    await page.route('**/api/v1/pull-request-reviews/runs?*', async route => {
      if (!rejectHistory) return route.continue();
      await historyRead.promise;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Review history temporarily unavailable.' }) });
    });
    await needsReview.getByText('Keep queue controls stable during reconnect').click();
    await browserExpect(panel.locator('[data-pr-review-loading]')).toBeVisible();
    await browserExpect(panel.getByRole('button', { name: 'Re-run', exact: true })).toBeDisabled();
    await browserExpect(panel.getByRole('button', { name: 'Post to GitHub' })).toBeDisabled();
    await browserExpect(panel.getByText('Not reviewed yet.', { exact: true })).toHaveCount(0);
    await capture('review-history-loading-desktop');
    historyRead.resolve();
    await browserExpect(panel.locator('[data-pr-review-history-error]')).toContainText('Review history temporarily unavailable.');
    await browserExpect(panel.getByRole('button', { name: 'Re-run', exact: true })).toBeDisabled();
    await capture('review-history-error-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-mobile-current-chat-menu]').getByRole('button').click();
    await page.getByRole('menuitem', { name: 'Open PRs', exact: true }).click();
    await browserExpect(panel.locator('[data-pr-review-history-error]')).toBeVisible();
    await capture('review-history-error-mobile');
    await page.setViewportSize({ width: 1920, height: 1080 });
    rejectHistory = false;
    await panel.locator('[data-pr-review-history-error]').getByRole('button', { name: 'Retry' }).click();
    await panel.locator('[data-pr-review-tab]').getByText('Queue pause is lost on reconnect.').waitFor();
    await browserExpect(panel.getByRole('button', { name: 'Post to GitHub' })).toBeEnabled();
    // Desktop shows the review chat beside the inbox.
    await page.locator('[data-workspace-surface-id^="chat-view:"]').getByText('Reviewed commit:', { exact: false }).last().waitFor();
    await capture('inbox-review-desktop');

    phase('changes and checks');
    await panel.locator('[data-pr-tab="changes"]').click();
    await panel.locator('[data-pr-detail]').getByText('example.txt').first().waitFor();
    await browserExpect(panel.getByRole('button', { name: 'Address with agent' })).toHaveCount(0);
    await capture('inbox-changes-desktop');
    await panel.locator('[data-pr-tab="checks"]').click();
    await panel.getByText('Unit tests', { exact: true }).waitFor();
    await browserExpect(panel.locator('[data-pr-checks-summary]')).toHaveText('2 passed · 1 neutral · 1 skipped');
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
    await capture('repositories-mobile');
    await page.keyboard.press('Escape');
    await panel.getByRole('button', { name: 'All pull requests' }).click();
    await browserExpect(needsReview).toBeVisible();
    await capture('inbox-mobile');

    phase('manage the connected repository directly in GitHub settings');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'GitHub', exact: true }).click();
    const settingsRepositories = settings.locator('[data-pr-repositories-panel]');
    await browserExpect(settingsRepositories.locator('[data-pr-repository="acme/app"]')).toBeVisible();
    await browserExpect(settingsRepositories.locator('[data-pr-run-log]')).toContainText('acme/app #128');
    await settings.getByText('Connected as synthetic-viewer@git.example.invalid', { exact: true }).waitFor();
    await capture('github-repositories-settings-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsRepositories.getByRole('button', { name: 'Edit acme/app' }).scrollIntoViewIfNeeded();
    await browserExpect(settingsRepositories.getByRole('switch', { name: 'Review acme/app automatically' })).toBeVisible();
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture('github-repositories-settings-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });
    phase('opt into automatic posting from Settings');
    await settingsRepositories.locator('[data-pr-repository="acme/app"]').getByRole('button', { name: 'Edit acme/app' }).click();
    const autoPost = connectForm.getByRole('checkbox', { name: 'Post reviews to GitHub automatically' });
    await browserExpect(autoPost).not.toBeChecked();
    await browserExpect(connectForm.locator('[data-pr-repository-save]')).toBeEnabled();
    await connectForm.getByText('Filters and limits', { exact: true }).click();
    await connectForm.getByRole('textbox', { name: 'Base branches', exact: true }).fill('main');
    await connectForm.getByRole('textbox', { name: 'Exclude these labels', exact: true }).fill('hold-review');
    await connectForm.getByRole('spinbutton', { name: 'Maximum changed lines', exact: true }).fill('');
    await connectForm.getByRole('spinbutton', { name: 'Attempts per head commit', exact: true }).fill('3');
    await connectForm.getByRole('spinbutton', { name: 'Daily review limit', exact: true }).fill('25');
    await connectForm.getByRole('spinbutton', { name: 'Daily review limit', exact: true }).scrollIntoViewIfNeeded();
    await capture('filters-limits-desktop');
    await connectForm.getByText('Applies to every review for this repository.', { exact: false }).scrollIntoViewIfNeeded();
    await capture('posting-settings-desktop');
    await autoPost.check();
    await connectForm.locator('[data-pr-repository-save]').click();
    await browserExpect(connectForm).toHaveCount(0);
    await browserExpect(settingsRepositories.locator('[data-pr-repository="acme/app"]')).toContainText('Automatic');
    const saved = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
    expect(saved.repositories[0].settings.autoPost).toBe(true);
    expect(saved.repositories[0].settings).toMatchObject({
      filters: { baseBranches: ['main'], excludeLabels: ['hold-review'], maxChangedLines: null },
      maxAttemptsPerCommit: 3, dailyReviewLimit: 25,
    });
    const settingsReview = snapshot.inbox.find(entry => entry.pull.number === 128)!.latestRun!;
    await settingsRepositories.locator(`[data-pr-recent-run="${settingsReview.id}"]`).getByRole('button', { name: 'Open chat' }).click();
    await browserExpect(settings).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-mobile-current-chat-menu]').getByRole('button').click();
    await page.getByRole('menuitem', { name: 'Open PRs', exact: true }).click();
    await panel.locator('[data-pr-repositories-button]').click();
    await repositories.locator('[data-pr-repository="acme/app"]').getByRole('button', { name: 'Edit acme/app' }).click();
    await browserExpect(autoPost).toBeChecked();
    await browserExpect(connectForm.locator('[data-pr-repository-save]')).toBeEnabled();
    await connectForm.getByText('Applies to every review for this repository.', { exact: false }).scrollIntoViewIfNeeded();
    await capture('posting-settings-mobile');
    await connectForm.getByText('Filters and limits', { exact: true }).click();
    await browserExpect(connectForm.getByRole('textbox', { name: 'Base branches', exact: true })).toHaveValue('main');
    await browserExpect(connectForm.getByRole('textbox', { name: 'Exclude these labels', exact: true })).toHaveValue('hold-review');
    await browserExpect(connectForm.getByRole('spinbutton', { name: 'Maximum changed lines', exact: true })).toHaveValue('');
    await browserExpect(connectForm.getByRole('spinbutton', { name: 'Attempts per head commit', exact: true })).toHaveValue('3');
    await browserExpect(connectForm.getByRole('spinbutton', { name: 'Daily review limit', exact: true })).toHaveValue('25');
    await connectForm.getByRole('spinbutton', { name: 'Daily review limit', exact: true }).scrollIntoViewIfNeeded();
    await capture('filters-limits-mobile');
    await page.keyboard.press('Escape');
    await browserExpect(connectForm).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The repository setting applies to subsequent reviews, not just the selected pull request.
    const activeRun = saved.inbox.find((entry) => entry.pull.number === 131)!.latestRun!;
    await client.post('/api/v1/pull-request-reviews/runs/stop', { runId: activeRun.id });
    await browserExpect.poll(async () => {
      const current = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
      return current.inbox.find((entry) => entry.pull.number === 133)?.latestRun?.post.status;
    }, { timeout: 30_000 }).toBe('posted');
    phase('post an earlier review without changing the latest run');
    const repositoryId = snapshot.repositories[0].id;
    const earlierRun = snapshot.inbox.find(entry => entry.pull.number === 128)!.latestRun!;
    const current = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
    const connected = current.repositories[0];
    await client.put('/api/v1/pull-request-reviews/repositories', {
      id: connected.id, repository: { target: connected.target, settings: { ...connected.settings, autoReview: false, autoPost: false } },
    });
    await client.post('/api/v1/pull-request-reviews/runs', { repositoryId, number: 128 });
    await browserExpect.poll(async () => {
      const current = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
      const latest = current.inbox.find(entry => entry.pull.number === 128)!.latestRun!;
      return latest.id !== earlierRun.id && latest.state === 'completed';
    }, { timeout: 30_000 }).toBe(true);
    await needsReview.getByText('Keep queue controls stable during reconnect').click();
    await panel.locator('[data-pr-tab="review"]').click();
    await panel.locator(`[data-pr-review-run="${earlierRun.id}"]`).click();
    await browserExpect(panel.getByRole('button', { name: 'Post to GitHub' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Post to GitHub' }).click();
    await browserExpect(panel.getByRole('link', { name: 'View the posted comment' })).toBeVisible();
    await browserExpect(panel.getByRole('button', { name: 'Post to GitHub' })).toHaveCount(0);
    const postedHistory = await client.get<PullRequestReviewRunsResponse>(`/api/v1/pull-request-reviews/runs?repositoryId=${repositoryId}&number=128`);
    expect(postedHistory.runs[0].post.status).toBe('none');
    expect(postedHistory.runs.find(run => run.id === earlierRun.id)?.post.status).toBe('posted');
    await capture('older-review-posted-mobile');

    phase('recover an unconfirmed post after the pull request closes');
    const githubFixturePath = join(project, 'gh-fixture.json');
    const githubFixture = JSON.parse(await readFile(githubFixturePath, 'utf8'));
    const recoveryPull = { number: 140, title: 'Recover a saved review after closure', headRefOid: HEAD };
    await writeFile(githubFixturePath, JSON.stringify({ ...githubFixture, pulls: [...PULLS, recoveryPull], commentResponse: '{' }));
    await client.post('/api/v1/pull-request-reviews/scan', { repositoryId });
    await browserExpect.poll(async () => (await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews'))
      .inbox.some(entry => entry.pull.number === 140)).toBe(true);
    const recovery = await client.post<PullRequestReviewRunMutationResponse>('/api/v1/pull-request-reviews/runs', { repositoryId, number: 140 });
    await browserExpect.poll(async () => (await client.get<PullRequestReviewRunsResponse>(
      `/api/v1/pull-request-reviews/runs?repositoryId=${repositoryId}&number=140`,
    )).runs[0]?.state, { timeout: 30_000 }).toBe('completed');
    const unconfirmed = await client.post<PullRequestReviewRunMutationResponse>('/api/v1/pull-request-reviews/runs/post', { runId: recovery.run.id });
    expect(unconfirmed.run.post.status).toBe('unknown');
    await writeFile(githubFixturePath, JSON.stringify({ ...githubFixture, pulls: [...PULLS, { ...recoveryPull, state: 'CLOSED' }] }));
    await client.post('/api/v1/pull-request-reviews/scan', { repositoryId });
    await browserExpect.poll(async () => (await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews'))
      .inbox.some(entry => entry.pull.number === 140)).toBe(false);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await panel.locator('[data-pr-repositories-button]').click();
    await repositories.getByRole('button', { name: 'Show all unresolved posts' }).click();
    const reconcile = repositories.locator(`[data-pr-reconcile-run="${recovery.run.id}"]`);
    await browserExpect(reconcile).toBeVisible();
    await reconcile.scrollIntoViewIfNeeded();
    await capture('closed-review-recovery-desktop');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.locator('[data-pr-repositories-button]').click();
    await repositories.getByRole('button', { name: 'Show all unresolved posts' }).click();
    await reconcile.scrollIntoViewIfNeeded();
    await capture('closed-review-recovery-mobile');
    await reconcile.click();
    await browserExpect(reconcile).toHaveCount(0);
    const recovered = await client.get<PullRequestReviewRunsResponse>(`/api/v1/pull-request-reviews/runs?repositoryId=${repositoryId}&number=140`);
    expect(recovered.runs[0].post.status).toBe('posted');
    const delivered = JSON.parse(await readFile(join(project, 'gh-comments.json'), 'utf8')) as { number: number }[];
    expect(delivered.filter(comment => comment.number === 140)).toHaveLength(1);

    phase('distinguish same-name connections and abandon an unreconcilable post');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1920, height: 1080 });
    const enterpriseProject = join(project, 'other-host');
    await mkdir(enterpriseProject);
    await initializeFixtureRepository(enterpriseProject);
    await writeFile(join(enterpriseProject, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic-viewer', owner: 'acme', repository: 'app', host: 'github.com', pulls: [] }));
    await client.post('/api/v1/pull-request-reviews/repositories', {
      target: { ...connected.target, projectPath: enterpriseProject }, settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
    });
    await browserExpect(panel.getByRole('option', { name: 'acme/app (github.com)' })).toHaveCount(1);
    await browserExpect(panel.getByRole('option', { name: 'acme/app (git.example.invalid)' })).toHaveCount(1);
    const abandonedPull = { number: 141, title: 'Stop recovery for a deleted pull request', headRefOid: HEAD };
    await writeFile(githubFixturePath, JSON.stringify({ ...githubFixture, pulls: [...PULLS, abandonedPull], commentResponse: '{' }));
    await client.post('/api/v1/pull-request-reviews/scan', { repositoryId });
    await browserExpect.poll(async () => (await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews')).inbox.some(entry => entry.pull.number === 141)).toBe(true);
    const abandoning = await client.post<PullRequestReviewRunMutationResponse>('/api/v1/pull-request-reviews/runs', { repositoryId, number: 141 });
    await browserExpect.poll(async () => (await client.get<PullRequestReviewRunsResponse>(`/api/v1/pull-request-reviews/runs?repositoryId=${repositoryId}&number=141`)).runs[0]?.state, { timeout: 30_000 }).toBe('completed');
    await client.post('/api/v1/pull-request-reviews/runs/post', { runId: abandoning.run.id });
    await writeFile(githubFixturePath, JSON.stringify({ ...githubFixture, pulls: PULLS }));
    await client.post('/api/v1/pull-request-reviews/scan', { repositoryId });
    await browserExpect.poll(async () => (await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews')).inbox.some(entry => entry.pull.number === 141)).toBe(false);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await panel.locator('[data-pr-repositories-button]').click();
    await browserExpect(repositories.getByRole('button', { name: 'Edit acme/app (github.com)' })).toBeVisible();
    await browserExpect(repositories.getByRole('button', { name: 'Edit acme/app (git.example.invalid)' })).toBeVisible();
    await capture('repository-hosts-desktop');
    await repositories.getByRole('button', { name: 'Show all unresolved posts' }).click();
    const abandoningRow = repositories.locator(`[data-pr-recent-run="${abandoning.run.id}"]`);
    await browserExpect(abandoningRow).toContainText('acme/app (git.example.invalid) #141');
    await abandoningRow.locator('[data-pr-abandon-run]').click();
    await capture('abandon-post-desktop');
    await abandoningRow.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.locator('[data-pr-repositories-button]').click();
    await repositories.getByRole('button', { name: 'Edit acme/app (github.com)' }).scrollIntoViewIfNeeded();
    await capture('repository-hosts-mobile');
    await repositories.getByRole('button', { name: 'Show all unresolved posts' }).click();
    await abandoningRow.locator('[data-pr-abandon-run]').scrollIntoViewIfNeeded();
    await abandoningRow.locator('[data-pr-abandon-run]').click();
    await abandoningRow.locator('[data-pr-confirm-abandon]').scrollIntoViewIfNeeded();
    await capture('abandon-post-mobile');
    await abandoningRow.locator('[data-pr-confirm-abandon]').click();
    await browserExpect(abandoningRow).toHaveCount(0);
    const abandoned = await client.get<PullRequestReviewRunsResponse>(`/api/v1/pull-request-reviews/runs?repositoryId=${repositoryId}&number=141`);
    expect(abandoned.runs[0].post).toMatchObject({ status: 'abandoned', abandonedAt: expect.any(String) });
    expect(JSON.parse(await readFile(join(project, 'gh-comments.json'), 'utf8')).filter((comment: { number: number }) => comment.number === 141)).toHaveLength(1);

    expect(browserErrors).toEqual([
      'console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
    ]);
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
          { __typename: 'CheckRun', name: 'Advisory', status: 'COMPLETED', conclusion: 'NEUTRAL', detailsUrl: 'https://git.example.invalid/acme/app/actions/advisory' },
          { __typename: 'CheckRun', name: 'Optional', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: 'https://git.example.invalid/acme/app/actions/optional' },
        ],
      }));
    },
  });
}, 180_000);
