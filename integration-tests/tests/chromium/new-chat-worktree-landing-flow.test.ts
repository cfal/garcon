import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, delimiter, join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { toExecutorPath } from '../../../server/common/executor-path.js';

const windowsGitPath = process.platform === 'win32'
  ? [dirname(Bun.which('git')!), dirname(process.execPath), join(process.env.SystemRoot ?? 'C:/Windows', 'System32')].join(delimiter)
  : undefined;

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`New Chat selects a worktree from the chosen project (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-worktree-landing-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client, executionDirs } = integration;
      const project = join(executionDirs.project, 'web-project');
      const otherProject = join(executionDirs.project, 'other-project');
      const linked = join(executionDirs.project, 'design-preview');
      await Promise.all([project, otherProject].map(path => mkdir(path, { recursive: true })));
      await initializeFixtureRepository(project);
      await initializeFixtureRepository(otherProject);
      await runFixtureGit(project, 'worktree', 'add', '-b', 'feature/design-preview', linked);
      await client.put('/api/v1/app/settings', { paths: {
        ...(client.executorId === 'local'
          ? { recentProjectPaths: [project], pinnedProjectPaths: [project, otherProject] }
          : { byExecutor: { [client.executorId]: { defaultPath: project, pinnedPaths: [project, otherProject] } } }),
      } });
      await page.addInitScript(seedLocalSettings, { composerStatusBarGitProjects: false, composerStatusBarNonGitProjects: false });
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: 'New Chat', exact: true });
      const projects = dialog.getByRole('region', { name: 'Saved and recent projects', exact: true });
      const projectCard = projects.getByRole('button', { name: client.executorId === 'local' ? project : `Integration worker: ${project}`, exact: true });
      await projectCard.click();
      await browserExpect(dialog.locator('#project-path-input')).toHaveCount(0);
      await dialog.locator('button[aria-label*=" / "]').first().click();
      await page.getByRole('button', { name: 'Chat Completions', exact: true }).click();
      await page.getByRole('button', { name: 'Integration Fake OpenAI', exact: true }).click();
      await page.getByRole('option', { name: 'Integration Echo', exact: true }).click();
      const prompt = dialog.getByPlaceholder('How can I help you today?');
      await prompt.fill('Review the selected worktree layout.');
      const worktrees = dialog.getByRole('region', { name: 'Worktrees', exact: true });
      await browserExpect(worktrees.getByText('feature/design-preview', { exact: true })).toBeVisible();
      await browserExpect(worktrees.getByRole('radio', { name: /^main/ })).toBeChecked();
      phase('switching projects without losing the prompt');
      await projects.getByRole('button', { name: client.executorId === 'local' ? otherProject : `Integration worker: ${otherProject}`, exact: true }).click();
      await browserExpect(worktrees.getByRole('radio', { name: /^main/ })).toBeChecked();
      await browserExpect(worktrees.getByRole('radio', { name: /feature\/design-preview/ })).toHaveCount(0);
      await browserExpect(prompt).toHaveValue('Review the selected worktree layout.');
      await projectCard.click();
      const selectedWorktree = worktrees.getByRole('radio', { name: /feature\/design-preview/ });
      phase('selecting a worktree with the keyboard');
      await selectedWorktree.focus();
      await page.keyboard.press('Space');
      await browserExpect(selectedWorktree).toBeChecked();
      await browserExpect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
      await browserExpect(selectedWorktree).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await browserExpect(worktrees.getByRole('radio', { name: /^main/ })).toBeChecked();
      await page.keyboard.press('ArrowDown');
      await browserExpect(selectedWorktree).toBeChecked();
      await browserExpect(prompt).toHaveValue('Review the selected worktree layout.');
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1440, 390, 360]) {
        phase(`checking the worktree list at ${width}px`);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 500 });
        await page.setViewportSize({ width, height: 900 });
        await worktrees.scrollIntoViewIfNeeded();
        expect(await worktrees.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(artifacts, `worktree-landing-${executionBackend}-${width}.png`) });
        await cdp.detach();
      }
      phase('submitting the captured executor and worktree');
      await page.setViewportSize({ width: 1440, height: 900 });
      const started = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/chats/start');
      await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
      const payload = (await started).postDataJSON();
      expect(payload.executorId ?? 'local').toBe(client.executorId);
      expect(payload.projectPath).toBe(toExecutorPath(linked));
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect.poll(async () => (await client.listChats()).sessions.some(chat => chat.projectPath === toExecutorPath(linked))).toBe(true);
      assertNoBrowserErrors();
      console.info(`Worktree landing assertions completed: ${executionBackend}`);
    }, undefined, {
      executionBackend,
      serverEnvironment: windowsGitPath ? { PATH: windowsGitPath } : {},
    });
  }, 120_000);
}
