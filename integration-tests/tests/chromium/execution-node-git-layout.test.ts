import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';

test('execution-node Git labels and GitHub host controls fit desktop and mobile', async () => {
  await withChromiumFixture('execution-node-git-layout', async (fixture, phase) => {
    const { client, executionDirs, directAgents } = fixture.integration;
    const label = 'Production build and review execution host';
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { label });
    await initializeFixtureRepository(executionDirs.project);
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
    const target = panel.getByRole('button', { name: `${label}: ${executionDirs.project}`, exact: true });
    await target.waitFor({ state: 'visible' });
    await panel.getByText('Synthetic remote change', { exact: false }).first().waitFor();
    phase('desktop Git target');
    expect(await target.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: join(artifacts, 'execution-node-git-desktop.png') });

    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
    await panel.getByText('Git is unavailable on this execution node.', { exact: true }).waitFor();
    expect(await panel.locator('[aria-busy="true"] > [aria-hidden="true"]').evaluate(element =>
      (element as HTMLElement).inert && element.hasAttribute('inert'),
    )).toBe(true);
    expect(await panel.getByRole('button', {
      name: `${label}: ${executionDirs.project}`, exact: true, includeHidden: true,
    }).isDisabled()).toBe(true);
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: true });
    await page.waitForFunction(() => document.querySelector(
      '[data-workspace-surface-id="singleton:git"] [data-git-surface-toolbar] button',
    )?.hasAttribute('disabled') === false);

    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Remote Settings', exact: true }).click();
    const host = page.getByRole('combobox', { name: 'Execution node', exact: true });
    const checked = page.waitForResponse(response => response.url().includes(`/api/v1/gh/status?nodeId=${client.nodeId}`));
    await host.selectOption(client.nodeId);
    const status = await checked;
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({ nodeId: client.nodeId, instanceId: expect.any(String) });
    await page.waitForFunction(() => {
      const section = document.querySelector('select[aria-label="Execution node"]')?.closest('section');
      return section && !section.textContent?.includes('Checking');
    });
    expect(await host.locator('xpath=ancestor::section').textContent()).not.toContain('GitHub CLI status check failed');
    for (const width of [1440, 390]) {
      phase(`GitHub host controls at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await host.scrollIntoViewIfNeeded();
      const geometry = await host.evaluate(element => {
        const section = element.closest('section')!;
        const bounds = section.getBoundingClientRect();
        const controls = [...section.querySelectorAll<HTMLElement>('button, select')].map(control => control.getBoundingClientRect());
        return {
          contained: controls.every(control => control.left >= bounds.left && control.right <= bounds.right),
          fits: section.scrollWidth <= section.clientWidth,
        };
      });
      expect(geometry).toEqual({ contained: true, fits: true });
      await page.screenshot({ path: join(artifacts, `execution-node-gh-${width}.png`) });
    }
    fixture.assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 120_000);
