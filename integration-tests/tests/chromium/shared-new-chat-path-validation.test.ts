import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Locator } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { clickWorkspaceWindowAddAction } from '../../support/chromium-workspace.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`shared New Chat surfaces validate explicit paths once before debounce (${executionBackend})`, async () => {
    await withChromiumFixture(`shared-path-validation-${executionBackend}`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
      const { client, executionDirs } = integration;
      const root = executionDirs.project;
      const pinned = join(root, 'pinned');
      const browsed = join(root, 'browsed');
      const worktree = join(root, 'worktree');
      await initializeFixtureRepository(root);
      await mkdir(pinned);
      await mkdir(browsed);
      await runFixtureGit(root, 'worktree', 'add', '-b', 'selected', worktree);
      await client.put('/api/v1/app/settings', { paths: {
        recentProjectPaths: [root], pinnedProjectPaths: [pinned],
        ...(client.executorId === 'local' ? {} : {
          byExecutor: { [client.executorId]: { defaultPath: root, pinnedPaths: [pinned] } },
        }),
      } });
      await page.goto(integration.garcon.baseUrl);
      await page.clock.install();

      const validations: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/api/v1/chats/validate-start') {
          validations.push(`${url.searchParams.get('executorId')} ${url.searchParams.get('path')}`);
        }
      });

      for (const surface of ['schedule', 'pull-request'] as const) {
        phase(`opening ${surface} configuration`);
        let editor: Locator;
        if (surface === 'schedule') {
          await page.getByRole('button', { name: 'More actions', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
          await page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true })
            .getByRole('button', { name: 'Add Prompt', exact: true }).click();
          editor = page.getByRole('dialog', { name: 'Add Scheduled Prompt', exact: true });
        } else {
          await clickWorkspaceWindowAddAction(page, 'Open Pull Requests');
          await page.locator('[data-pr-inbox-connect]').click();
          editor = page.locator('[data-pr-repository-dialog]');
        }
        if (client.executorId !== 'local') {
          await editor.locator('[data-executor-picker]').click();
          await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
        }
        const input = editor.getByRole('textbox', { name: 'Project Path', exact: true });
        const success = editor.locator('[data-slot="project-path-field"] .text-status-success-foreground');
        await browserExpect(input).toHaveValue(root);
        await browserExpect(success).toBeVisible();

        async function selectedOnce(path: string, select: () => Promise<unknown>): Promise<void> {
          const key = `${client.executorId} ${path}`;
          const previous = validations.filter(value => value === key).length;
          await page.clock.pauseAt(await page.evaluate(() => Date.now()));
          const requested = page.waitForRequest(request => {
            const url = new URL(request.url());
            return url.pathname === '/api/v1/chats/validate-start'
              && url.searchParams.get('executorId') === client.executorId
              && url.searchParams.get('path') === path;
          }, { timeout: 2_000 });
          await select();
          await requested;
          await browserExpect(success).toBeVisible();
          await page.clock.runFor(300);
          expect(validations.filter(value => value === key)).toHaveLength(previous + 1);
          await browserExpect(success).toBeVisible();
          await browserExpect(input).toHaveValue(path);
          await page.clock.resume();
        }

        phase(`${surface}: selecting a pin without waiting for debounce`);
        await selectedOnce(pinned, () => editor.getByRole('button', { name: pinned, exact: true }).dispatchEvent('click'));

        phase(`${surface}: selecting a directory without waiting for debounce`);
        await input.click();
        await input.fill(`${root}/`);
        const browser = page.getByRole('dialog', { name: 'Select Directory', exact: true });
        const directory = browser.getByRole('button', { name: 'browsed', exact: true });
        await browserExpect(directory).toBeVisible();
        await selectedOnce(browsed, () => directory.dispatchEvent('click'));
        await input.press('Enter');
        await browserExpect(browser).toHaveCount(0);

        phase(`${surface}: selecting a worktree without a duplicate inspection`);
        await editor.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
        const picker = page.getByRole('dialog', { name: 'Select worktree', exact: true });
        const option = picker.getByRole('option').filter({ hasText: worktree });
        await browserExpect(option).toBeVisible();
        await selectedOnce(worktree, () => option.dispatchEvent('click'));
        await browserExpect(picker).toHaveCount(0);

        phase(`${surface}: preserving typed-path debounce`);
        const typedKey = `${client.executorId} ${root}`;
        const previous = validations.filter(value => value === typedKey).length;
        await page.clock.pauseAt(await page.evaluate(() => Date.now()));
        await input.fill(root);
        await input.press('Enter');
        await page.clock.runFor(299);
        expect(validations.filter(value => value === typedKey)).toHaveLength(previous);
        await page.clock.runFor(1);
        await browserExpect(success).toBeVisible();
        expect(validations.filter(value => value === typedKey)).toHaveLength(previous + 1);
        await page.clock.resume();

        if (executionBackend === 'in-process') {
          const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
          await mkdir(artifacts, { recursive: true });
          for (const width of surface === 'schedule' ? [1440, 390] : [1440]) {
            await page.setViewportSize({ width, height: 900 });
            await browserExpect(editor).toBeVisible();
            await browserExpect.poll(() => editor.evaluate(element => {
              const bounds = element.getBoundingClientRect();
              return bounds.left >= -1 && bounds.right <= innerWidth + 1;
            })).toBe(true);
            await page.screenshot({ path: join(artifacts, `shared-path-validation-${surface}-${width}.png`), animations: 'disabled' });
          }
          await page.setViewportSize({ width: 1440, height: 900 });
        }
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        await browserExpect(editor).toHaveCount(0);
        if (surface === 'schedule') {
          await page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true })
            .getByRole('button', { name: 'Close', exact: true }).first().click();
        } else if (executionBackend === 'in-process') {
          phase('capturing the mobile repository configuration');
          await page.setViewportSize({ width: 390, height: 900 });
          await page.locator('[data-pr-inbox-connect]').click();
          await browserExpect(editor).toBeVisible();
          await browserExpect(success).toBeVisible();
          await page.screenshot({ path: join(import.meta.dirname, '../../artifacts/chromium/shared-path-validation-pull-request-390.png'), animations: 'disabled' });
          await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
          await page.setViewportSize({ width: 1440, height: 900 });
        }
      }
      expect((await client.listChats()).sessions).toEqual([]);
      assertNoBrowserErrors();
    }, undefined, { executionBackend });
  }, 120_000);
}
