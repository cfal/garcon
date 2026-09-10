import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { fixtureGit } from '../../support/fixture-git.js';
import { SpaDriver } from '../../support/spa-driver.js';

async function expectStandaloneControls(page: Page): Promise<void> {
  expect(await page.evaluate(() => [
    ...document.querySelectorAll<HTMLElement>(
      '[data-execution-node-control], [data-execution-node-status], [data-execution-instance-control]',
    ),
  ].length)).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
    'button, [role="combobox"], [role="status"]',
  )].filter((element) => /^(Select node|Execution node|Local node|Pair a node)(?:$|:)/i.test(
    element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '',
  )).length)).toBe(0);
}

describe('Lightpanda standalone defaults', () => {
  test('keeps ordinary chat and workspace surfaces free of placement setup', async () => {
    await withE2eFixture('standalone-defaults', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await expectStandaloneControls(fixture.page);

      await app.clickButton('New Chat');
      await fixture.page.waitForSelector('[role="dialog"] input[aria-label="Project Path"]');
      await expectStandaloneControls(fixture.page);
      await app.clickButton('Close');
      await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
      await app.startOpenAiDirectChat('synthetic standalone input');
      await app.waitForText('echo:synthetic standalone input');
      await expectStandaloneControls(fixture.page);
      const chatWindowId = await app.currentWorkspaceWindowId();

      await app.selectWorkspaceWindowSurface('Open Files', chatWindowId);
      await fixture.page.waitForSelector('[data-file-tree-grid]');
      await app.waitForText('synthetic-file.txt');
      await expectStandaloneControls(fixture.page);

      await app.selectWorkspaceWindowSurface('Open Git Workbench', chatWindowId);
      await fixture.page.waitForSelector('[data-workspace-surface-id="singleton:git"]');
      await expectStandaloneControls(fixture.page);

      await app.selectWorkspaceWindowSurface('New Terminal', chatWindowId);
      await fixture.page.waitForSelector('[data-workspace-surface-id^="terminal:"]');
      await expectStandaloneControls(fixture.page);
      fixture.assertNoBrowserErrors();
    }, {
      bindAddress: '0.0.0.0', authentication: 'account',
      serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/true' },
      async prepareWorkspace(directories) {
        await writeFile(join(directories.project, 'synthetic-file.txt'), 'synthetic file content\n');
        await fixtureGit(directories.project, 'init', '-b', 'main');
        await fixtureGit(directories.project, 'commit', '--allow-empty', '-m', 'Synthetic initial revision');
      },
    });
  }, 60_000);
});
