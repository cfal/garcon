import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { toExecutorPath } from '../../../server/common/executor-path.js';
import type { CreateWorktreeOptions } from '../../../common/git.js';

type WorktreeCreationRequest = Omit<CreateWorktreeOptions, 'projectPath'> & {
  executorId: string;
  project: CreateWorktreeOptions['projectPath'];
};

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`New Chat keeps active project actions visible and creates a selected worktree (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-review-regressions-${executionBackend}`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
      const { client, executionDirs } = integration;
      const project = join(executionDirs.project, 'active-project');
      const browsed = join(executionDirs.project, 'browsed-project');
      const saved = Array.from({ length: 5 }, (_, index) => join(executionDirs.project, `saved-${index + 1}`));
      await Promise.all([project, browsed, ...saved].map(path => mkdir(path, { recursive: true })));
      await initializeFixtureRepository(project);
      await client.put('/api/v1/app/settings', { paths: {
        pinnedProjectPaths: saved.map(path => toExecutorPath(path)),
        ...(client.executorId === 'local'
          ? { recentProjectPaths: [toExecutorPath(project)] }
          : { byExecutor: { [client.executorId]: { defaultPath: toExecutorPath(project), pinnedPaths: [toExecutorPath(project)] } } }),
      } });
      await page.addInitScript(seedLocalSettings, { composerStatusBarGitProjects: false, composerStatusBarNonGitProjects: false });
      await page.goto(integration.garcon.baseUrl);
      const landing = page.getByRole('dialog', { name: 'New Chat', exact: true });
      await browserExpect(landing).toBeVisible();
      if (client.executorId !== 'local') {
        await landing.locator('[data-slot="new-chat-project-picker"]').getByRole('button', { name: /^Executor:/ }).click();
        await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
      }
      const projects = landing.getByRole('region', { name: 'Saved and recent projects', exact: true });
      const primary = projects.locator('[data-slot="new-chat-project-select"]');
      const activeCard = primary.filter({ hasText: 'active-project' });
      const prompt = landing.getByPlaceholder('How can I help you today?');
      await prompt.fill('Synthetic review regression draft');
      phase('keeping a startup selection visible beyond five saved projects');
      await browserExpect(primary).toHaveCount(5);
      await browserExpect(primary.first()).toHaveAttribute('title', toExecutorPath(project));
      await browserExpect(activeCard).toHaveAttribute('aria-pressed', 'true');
      await activeCard.locator('..').getByRole('button', { name: /^Project actions:/ }).click();
      await browserExpect(page.getByRole('menuitem', { name: /^(Pin|Unpin)$/, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');

      phase('keeping a browsed project and its actions visible without reopening More');
      await landing.getByRole('button', { name: 'Choose folder', exact: true }).click();
      const browser = landing.getByRole('dialog', { name: 'Select Directory', exact: true });
      await browser.getByRole('button', { name: 'browsed-project', exact: true }).click();
      await browser.getByRole('button', { name: 'Close', exact: true }).click();
      const browsedCard = primary.filter({ hasText: 'browsed-project' });
      await browserExpect(primary.first()).toHaveAttribute('title', toExecutorPath(browsed));
      await browserExpect(browsedCard).toHaveAttribute('aria-pressed', 'true');
      await browsedCard.locator('..').getByRole('button', { name: /^Project actions:/ }).click();
      await browserExpect(page.getByRole('menuitem', { name: 'Pin', exact: true })).toBeVisible();
      await browserExpect(page.getByRole('menuitem', { name: 'Remove from list', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(prompt).toHaveValue('Synthetic review regression draft');

      phase('creating a worktree through the landing action on the selected executor');
      await landing.getByRole('button', { name: 'Choose folder', exact: true }).click();
      await browser.getByRole('button', { name: 'active-project', exact: true }).click();
      await browser.getByRole('button', { name: 'Close', exact: true }).click();
      const worktrees = landing.getByRole('region', { name: 'Worktrees', exact: true });
      await browserExpect(worktrees.getByRole('radio', { name: /^main/ })).toBeChecked();
      await worktrees.getByRole('button', { name: 'New worktree', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Select worktree', exact: true });
      await picker.getByRole('button', { name: 'New worktree', exact: true }).click();
      const creation = page.getByRole('dialog', { name: 'New worktree', exact: true });
      await creation.getByRole('textbox', { name: /branch name/i }).fill('review-created');
      const createRequest = page.waitForRequest(request => request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/v1/git/worktrees/create');
      await creation.getByRole('button', { name: 'Create worktree', exact: true }).click();
      const payload: WorktreeCreationRequest = (await createRequest).postDataJSON();
      expect(payload.executorId).toBe(client.executorId);
      expect(payload.project).toBe(toExecutorPath(project));
      expect(payload.branch).toBe('review-created');
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(creation).toHaveCount(0);
      await browserExpect(worktrees.getByRole('radio', { name: /review-created/ })).toBeChecked();
      await browserExpect(landing.getByRole('textbox', { name: 'Project Path', exact: true })).toHaveValue(payload.worktreePath);
      await browserExpect(activeCard).toHaveAttribute('aria-pressed', 'true');
      await browserExpect(prompt).toHaveValue('Synthetic review regression draft');
      expect(await client.listChats()).toMatchObject({ sessions: [] });
      assertNoBrowserErrors();
      console.info(`New Chat review regressions completed: ${executionBackend}`);
    }, undefined, { executionBackend });
  }, 120_000);
}
