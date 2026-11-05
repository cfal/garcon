import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS, type PullRequestReviewsSnapshot } from '../../../common/pull-request-reviews.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

const lineCount = 2_500;
const threadLine = 1_000;
const githubFixture = {
  label: 'synthetic-reviewer',
  pulls: [{ number: 1, title: 'Synthetic large review', updatedAt: '2026-01-01T00:00:00Z' }],
  files: [{ path: 'a.txt', additions: 1, deletions: 0 }, { path: 'large.ts', additions: lineCount, deletions: 0 }],
  diff: [
    'diff --git a/a.txt b/a.txt', '--- /dev/null', '+++ b/a.txt', '@@ -0,0 +1 @@', '+small file',
    'diff --git a/large.ts b/large.ts', '--- /dev/null', '+++ b/large.ts', `@@ -0,0 +1,${lineCount} @@`,
    ...Array.from({ length: lineCount }, (_, index) => `+export const value${index + 1} = "\u4e2d\ud83d\ude80";`),
    '',
  ].join('\n'),
  commentPages: [[{
    id: 1, path: 'large.ts', line: threadLine, side: 'RIGHT', body: 'Synthetic anchored review comment', user: { login: 'synthetic-author' },
  }]],
};

test('retains a large highlighted threaded review through inbox refresh, failure and retry', async () => {
  await withChromiumFixture('git-large-diff-refresh', async (fixture, phase) => {
    const { page, integration } = fixture;
    const { client, executionDirs } = integration;
    const settleRender = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await initializeFixtureRepository(executionDirs.project);
    await client.post('/api/v1/pull-request-reviews/repositories', {
      target: {
        type: 'new-chat', executorId: client.executorId, agentId: 'shell', model: 'sh', projectPath: executionDirs.project,
        apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
        agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' },
      },
      settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
    });
    const snapshot = await client.get<PullRequestReviewsSnapshot>('/api/v1/pull-request-reviews');
    const repositoryId = snapshot.repositories[0].id;
    const workerUrls: string[] = [];
    page.on('worker', worker => workerUrls.push(worker.url()));
    await page.goto(integration.garcon.baseUrl);
    await collapseCanonicalFilesWindow(page);
    await clickWorkspaceWindowAddAction(page, 'Open Pull Requests');
    const panel = page.locator('[data-workspace-surface-id="singleton:pull-requests"][aria-hidden="false"]');
    await panel.locator('[data-pr-inbox-row]').first().click();
    await panel.locator('[data-pr-tab="changes"]').click();
    await panel.getByText('+small file', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Viewed', exact: true }).first().click();
    await browserExpect(panel.getByText('1/2 viewed', { exact: true })).toBeVisible();
    await browserExpect(panel.locator('.cm-code-keyword').first()).toBeVisible();
    expect(workerUrls.some(url => url.includes('git-review-worker'))).toBe(true);

    phase('deep scrolling to an anchored thread');
    const viewport = panel.locator('[data-git-virtual-diff-root]');
    await viewport.evaluate((element, line) => {
      const row = element.querySelector('[data-git-diff-review-row]')!.closest('[data-git-virtual-row]')!;
      element.scrollTop = (line - 5) * row.getBoundingClientRect().height;
    }, threadLine);
    const thread = panel.getByRole('button', { name: `large.ts:${threadLine}` });
    await browserExpect(thread).toBeVisible();
    await browserExpect(panel.getByText('Synthetic anchored review comment', { exact: true })).toBeVisible();
    await thread.click();
    await browserExpect(thread).toHaveAttribute('aria-expanded', 'false');
    await settleRender();
    // Holds real DOM nodes and a native selection, not just matching replacement text.
    const row = await panel.locator('[data-git-diff-review-row]').first().elementHandle();
    if (!row) throw new Error('Missing deep review row');
    const selected = await row.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected).not.toBe('');
    const scrollTop = await viewport.evaluate(element => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(1_000);
    expect(await panel.locator('[data-git-virtual-row]').count()).toBeLessThan(200);
    const indexTime = await page.evaluate(() => performance.getEntriesByName('garcon.git-review.worker.patch-index')[0]?.startTime);
    expect(indexTime).toBeDefined();
    const syntaxTime = await page.evaluate(() => performance.getEntriesByName('garcon.git-review.worker.syntax-project')[0]?.startTime);
    expect(syntaxTime).toBeDefined();
    const assertRetained = async () => {
      expect(await row.evaluate(element => element.isConnected)).toBe(true);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
      expect(await viewport.evaluate(element => element.scrollTop)).toBe(scrollTop);
      await browserExpect(thread).toHaveAttribute('aria-expanded', 'false');
      await browserExpect(panel.getByText('1/2 viewed', { exact: true })).toBeVisible();
      await browserExpect(panel.locator('[data-git-diff-review-row]').last().locator('.cm-code-keyword').first()).toBeVisible();
      expect(await page.evaluate(() => performance.getEntriesByName('garcon.git-review.worker.patch-index')[0]?.startTime)).toBe(indexTime);
      expect(await page.evaluate(() => performance.getEntriesByName('garcon.git-review.worker.syntax-project')[0]?.startTime)).toBe(syntaxTime);
    };

    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let failing = false;
    let requests = 0;
    await page.route('**/api/v1/gh/pull-request?**', async route => {
      requests++;
      requested.resolve();
      await release.promise;
      if (failing) await route.fulfill({ status: 503, json: { error: 'Synthetic refresh failure', errorCode: 'GH_OPERATION_FAILED' } });
      else await route.continue();
    });
    try {
      phase('inbox metadata refresh with detail response held');
      await writeFile(join(executionDirs.project, 'gh-fixture.json'), JSON.stringify({
        ...githubFixture, pulls: [{ ...githubFixture.pulls[0], updatedAt: '2026-01-02T00:00:00Z' }],
      }));
      await client.post('/api/v1/pull-request-reviews/scan', { repositoryId });
      await requested.promise;
      await settleRender();
      await assertRetained();
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/gh/pull-request');
      release.resolve();
      const response = await refreshed;
      expect(response.status()).toBe(200);
      await response.finished();
      await settleRender();
      const refresh = panel.locator('[data-pr-detail]').getByRole('button', { name: 'Refresh', exact: true });
      await assertRetained();

      phase('failed refresh and explicit retry');
      failing = true;
      // DOM clicks avoid replacing the native selection through pointer focus.
      await refresh.evaluate(element => (element as HTMLButtonElement).click());
      await browserExpect(panel.locator('[data-pr-detail]').getByText('Synthetic refresh failure', { exact: true })).toBeVisible();
      await assertRetained();
      expect(requests).toBe(2);
      failing = false;
      const retry = panel.locator('[data-pr-detail]').getByRole('button', { name: 'Retry', exact: true });
      const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/gh/pull-request');
      await retry.evaluate(element => (element as HTMLButtonElement).click());
      const retryResponse = await retried;
      expect(retryResponse.status()).toBe(200);
      await retryResponse.finished();
      await settleRender();
      await browserExpect(retry).toHaveCount(0);
      await assertRetained();
      expect(requests).toBe(3);
      fixture.consumeExpectedBrowserErrors(['console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
    } finally {
      release.resolve();
      await row.dispose();
    }
  }, undefined, {
    executionBackend: 'remote-controller-dials', projectRoots: 'separate',
    resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'gh-bin') }),
    prepareWorkspace: async dirs => {
      const bin = join(dirs.root, 'gh-bin');
      await mkdir(bin);
      await copyFile(new URL('../../../server/remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
      await chmod(join(bin, 'gh'), 0o755);
      await symlink(process.execPath, join(bin, 'bun'));
      await symlink(Bun.which('git')!, join(bin, 'git'));
      await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify(githubFixture));
    },
  });
}, 120_000);
