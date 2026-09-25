import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

test('executor Git labels and GitHub host controls fit desktop and mobile', async () => {
  await withChromiumFixture('executor-git-layout', async (fixture, phase) => {
    const { client, executionDirs, directAgents } = fixture.integration;
    const label = 'Production build and review execution host';
    await client.patch(`/api/v1/executors/${client.executorId}`, { label });
    await initializeFixtureRepository(executionDirs.project);
    await runFixtureGit(executionDirs.project, 'branch', '-m', 'feature/long-branch-for-executor-layout');
    await writeFile(join(executionDirs.project, 'example.txt'), 'Synthetic remote change\n');
    const chatId = fixture.integration.newChatId();
    const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project, content: 'Synthetic Git layout chat', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    const { page } = fixture;
    const artifacts = fileURLToPath(new URL('../../artifacts/chromium', import.meta.url));
    await mkdir(artifacts, { recursive: true });
    await page.goto(`${fixture.integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await clickWorkspaceWindowAddAction(page, 'Open Git Workbench');
    const panel = page.locator('[data-workspace-surface-id="singleton:git"][aria-hidden="false"]');
    const target = panel.getByRole('button', { name: executionDirs.project, exact: true });
    const executorPicker = panel.getByRole('button', { name: `Executor: ${label}`, exact: true });
    await target.waitFor({ state: 'visible' });
    await executorPicker.waitFor({ state: 'visible' });
    await panel.getByText('Synthetic remote change', { exact: false }).first().waitFor();
    phase('desktop Git target');
    expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: join(artifacts, 'executor-git-desktop.png') });

    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
    await panel.getByText('Git is unavailable on this executor.', { exact: true }).waitFor();
    expect(await panel.locator('[aria-busy="true"] > [aria-hidden="true"]').evaluate(element =>
      (element as HTMLElement).inert && element.hasAttribute('inert'),
    )).toBe(true);
    expect(await panel.getByRole('button', {
      name: executionDirs.project, exact: true, includeHidden: true,
    }).isDisabled()).toBe(true);
    expect(await executorPicker.isDisabled()).toBe(false);
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
    await page.waitForFunction(() => document.querySelector(
      '[data-workspace-surface-id="singleton:git"] [data-git-folder-picker]',
    )?.hasAttribute('disabled') === false);

    phase('mobile Git target');
    await page.setViewportSize({ width: 390, height: 900 });
    const mobilePanel = page.locator('.mobile-shell [data-workspace-surface-id="singleton:git"][aria-hidden="false"]');
    const mobileTarget = mobilePanel.getByRole('button', { name: executionDirs.project, exact: true });
    await mobileTarget.waitFor({ state: 'visible' });
    expect(await mobileTarget.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await mobilePanel.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll<HTMLElement>('[data-git-surface-toolbar] button')]
        .filter(button => button.checkVisibility({ checkVisibilityCSS: true }));
      const rectangles = controls.map(control => control.getBoundingClientRect());
      return controls.length > 0 && rectangles.every((rect, index) =>
        rect.width > 0 && rect.left >= bounds.left && rect.right <= bounds.right
        && rectangles.slice(index + 1).every(other =>
          rect.right <= other.left || rect.left >= other.right || rect.bottom <= other.top || rect.top >= other.bottom),
      );
    })).toBe(true);
    for (const selector of ['[data-executor-picker] span', '[data-popover-trigger] span']) {
      expect(await mobilePanel.locator(selector).first().evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(40);
    }
    await page.screenshot({ path: join(artifacts, 'executor-git-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Server Settings', exact: true }).click();
    const checked = page.waitForResponse(response => response.url().includes(`/api/v1/gh/status?executorId=${client.executorId}`));
    await page.getByRole('tab', { name: 'GitHub', exact: true }).click();
    const host = page.getByRole('region', { name: label, exact: true });
    const status = await checked;
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ executorId: client.executorId, instanceId: expect.any(String) });
    await page.waitForFunction((name) => {
      const section = document.querySelector(`section[aria-label="${name}"]`);
      return section && !section.textContent?.includes('Checking');
    }, label);
    expect(await host.textContent()).not.toContain('GitHub CLI status check failed');
    for (const width of [1440, 390]) {
      phase(`GitHub host controls at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await host.scrollIntoViewIfNeeded();
      const geometry = await host.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const controls = [...element.querySelectorAll<HTMLElement>('button')].map(control => control.getBoundingClientRect());
        return {
          contained: controls.every(control => control.left >= bounds.left && control.right <= bounds.right),
          fits: element.scrollWidth <= element.clientWidth,
        };
      });
      expect(geometry).toEqual({ contained: true, fits: true });
      await page.screenshot({ path: join(artifacts, `executor-gh-${width}.png`) });
    }
    fixture.assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 120_000);
