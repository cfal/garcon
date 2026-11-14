import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { descriptorPathsDirectory } from '../../../server/runtime/files/directory-creation.js';
import { saveNewChatProject } from '../../support/new-chat-project.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test.skipIf(descriptorPathsDirectory() === null)(`directory browser selects and creates directories on the owning executor (${executionBackend})`, async () => {
    await withChromiumFixture(`directory-browser-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const root = integration.executionDirs.project;
      for (const name of ['alpha/nested', 'alpha/notes', 'beta']) await mkdir(join(root, name), { recursive: true });
      await saveNewChatProject(integration.client, root);
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      const screenshot = (name: string) => page.screenshot({ path: join(artifacts, `directory-browser-${executionBackend}-${name}.png`) });
      const browser = page.getByRole('dialog', { name: 'Select Directory', exact: true });
      const control = (name: string) => browser.getByRole('button', { name, exact: true });
      const creations: string[] = [];
      page.on('request', request => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && url.pathname === '/api/v1/files/directories') {
          creations.push(`${url.searchParams.get('executorId')} ${url.searchParams.get('path')} ${request.postData()}`);
        }
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const landing = page.getByRole('dialog', { name: 'New Chat', exact: true });
      const choose = landing.getByRole('button', { name: 'Choose project', exact: true });
      const projectCard = landing.getByRole('button', { name: integration.client.executorId === 'local' ? root : `Integration worker: ${root}`, exact: true });
      await projectCard.click();
      const worktrees = landing.getByRole('region', { name: 'Worktrees', exact: true });
      const selectedPath = () => worktrees.getByText(root, { exact: true });
      const prompt = landing.getByPlaceholder('How can I help you today?');
      await prompt.fill('Preserve this directory-selection draft');

      phase('touch navigation remains unselected until confirmation');
      await choose.click();
      await browserExpect(control('alpha')).toBeVisible();
      for (const target of [browser.locator('[aria-current="location"]'), ...['alpha', 'Cancel', 'New directory', 'Select this directory'].map(control)]) {
        expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      await screenshot('sheet');
      await control('alpha').click();
      await browserExpect(control('nested')).toBeVisible();
      await control('nested').click();
      await browserExpect(browser.getByText('No subdirectories')).toBeVisible();
      await control('Parent directory').click();
      await browserExpect(control('notes')).toBeVisible();
      await control('Cancel').click();
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(selectedPath()).toBeVisible();

      phase('touch creation selects only on confirmation');
      await choose.click();
      await control('alpha').click();
      await browser.getByRole('textbox', { name: 'Filter directories...' }).fill('touch');
      await control('Create directory "touch"').click();
      const name = browser.getByRole('textbox', { name: 'Directory name' });
      await browserExpect(name).toBeFocused();
      expect(await name.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await name.fill('touch created ');
      await screenshot('sheet-create');
      await control('Create').click();
      await browserExpect(control('Select this directory')).toBeFocused();
      const touchCreated = join(root, 'alpha', 'touch created');
      expect((await stat(touchCreated)).isDirectory()).toBe(true);
      await control('Select this directory').click();
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(worktrees.getByText(touchCreated, { exact: true })).toBeVisible();

      phase('Escape cancels creation before closing the browser');
      await choose.click();
      await control('Parent directory').click();
      await control('New directory').click();
      await name.fill('ghost');
      await page.keyboard.press('Escape');
      await browserExpect(name).toHaveCount(0);
      await browserExpect(control('New directory')).toBeFocused();
      await page.keyboard.press('Escape');
      await browserExpect(browser).toHaveCount(0);
      expect(await readdir(join(root, 'alpha'))).not.toContain('ghost');

      phase('desktop chooser traverses nested folders without closing');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await page.setViewportSize({ width: 1280, height: 800 });
      await projectCard.click();
      await choose.click();
      await control('alpha').click();
      await browserExpect(browser).toBeVisible();
      await browserExpect(control('nested')).toBeVisible();
      await control('nested').click();
      await browserExpect(browser.getByText('No subdirectories')).toBeVisible();
      await control('Parent directory').click();
      await control('New directory').click();
      await name.fill('desktop created');
      await screenshot('popover-create');
      await name.press('Enter');
      const desktopCreated = join(root, 'alpha', 'desktop created');
      await browserExpect(name).toHaveCount(0);
      await browserExpect(browser).toBeVisible();
      await browserExpect(browser.getByText('No subdirectories')).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(worktrees.getByText(desktopCreated, { exact: true })).toBeVisible();
      await browserExpect(prompt).toHaveValue('Preserve this directory-selection draft');
      await browserExpect(landing.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
      const executorId = integration.client.executorId;
      expect(creations).toEqual([
        `${executorId} ${join(root, 'alpha')} {"name":"touch created"}`,
        `${executorId} ${join(root, 'alpha')} {"name":"desktop created"}`,
      ]);
      expect((await readdir(join(root, 'alpha'))).sort()).toEqual(['desktop created', 'nested', 'notes', 'touch created']);
      if (executionBackend !== 'in-process') expect(await readdir(integration.dirs.project)).toEqual([]);
      expect((await integration.client.listChats()).sessions).toEqual([]);
      await cdp.detach();
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
