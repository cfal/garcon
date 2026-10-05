import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { descriptorPathsDirectory } from '../../../server/runtime/files/directory-creation.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  // Creating needs executors that name open descriptors by path; elsewhere the picker hides the controls.
  test.skipIf(descriptorPathsDirectory() === null)(`directory browser selects and creates directories on the owning executor (${executionBackend})`, async () => {
    await withChromiumFixture(`directory-browser-${executionBackend}`, async ({ page, context, integration, browserErrors, failedResponses }, phase) => {
      const root = integration.executionDirs.project;
      for (const name of ['alpha/nested', 'alpha/notes', 'beta']) await mkdir(join(root, name), { recursive: true });
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      const screenshot = (name: string) => page.screenshot({ path: join(artifacts, `directory-browser-${executionBackend}-${name}.png`) });
      const input = page.locator('#project-path-input');
      const browser = page.getByRole('dialog', { name: 'Select Directory', exact: true });
      const control = (name: string) => browser.getByRole('button', { name, exact: true });
      const openNewChat = async () => {
        await page.goto(integration.garcon.baseUrl);
        await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
        await browserExpect(input).toBeVisible();
        if (executionBackend === 'in-process') return;
        await page.getByRole('dialog').locator('[data-executor-picker]').click();
        await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
      };
      const creations: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'POST' && url.pathname === '/api/v1/files/directories') {
          creations.push(`${url.searchParams.get('executorId')} ${url.searchParams.get('path')} ${request.postData()}`);
        }
      });

      phase('touch sheet opens on the field directory and navigates without selecting');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await openNewChat();
      const initialPath = await input.inputValue();
      await input.click();
      await browserExpect(control('alpha')).toBeVisible();
      await browserExpect(control('beta')).toBeVisible();
      await screenshot('sheet');
      const touchTargets = [browser.locator('[aria-current="location"]'), ...['alpha', 'Cancel', 'New directory', 'Select this directory'].map(control)];
      for (const target of touchTargets) expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await control('alpha').click();
      await browserExpect(control('nested')).toBeVisible();
      await browserExpect(control('notes')).toBeVisible();
      await control('nested').click();
      await browserExpect(browser.getByText('No subdirectories')).toBeVisible();
      await control('Parent directory').click();
      await browserExpect(control('notes')).toBeVisible();
      await control('Cancel').click();
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(input).toHaveValue(initialPath);

      phase('touch sheet creates a directory and selects it on confirmation');
      await input.click();
      await control('alpha').click();
      await browserExpect(control('nested')).toBeVisible();
      await browser.getByRole('textbox', { name: 'Filter directories...' }).fill('touch');
      await browserExpect(control('nested')).toHaveCount(0);
      await control('Create directory "touch"').click();
      const name = browser.getByRole('textbox', { name: 'Directory name' });
      await browserExpect(name).toBeFocused();
      await browserExpect(name).toHaveValue('touch');
      expect(await name.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      await name.fill('touch created ');
      await screenshot('sheet-create');
      await control('Create').click();
      const confirm = control('Select this directory');
      await browserExpect(confirm).toBeFocused();
      await browserExpect(browser.getByText('No subdirectories')).toBeVisible();
      const touchCreated = join(root, 'alpha', 'touch created');
      expect((await stat(touchCreated)).isDirectory()).toBe(true);
      await browserExpect(input).toHaveValue(initialPath);
      await confirm.click();
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(input).toHaveValue(touchCreated);

      phase('touch sheet falls back from a missing path and Escape leaves one step at a time');
      await input.click();
      await control('Parent directory').click();
      await control('New directory').click();
      await name.fill('ghost');
      await page.keyboard.press('Escape');
      await browserExpect(name).toHaveCount(0);
      await browserExpect(control('New directory')).toBeFocused();
      await page.keyboard.press('Escape');
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(input).toHaveValue(touchCreated);
      expect(await readdir(join(root, 'alpha'))).not.toContain('ghost');

      // The touch field opens the sheet on focus, so the stale path is written without focusing it.
      const stalePath = join(root, 'alpha', 'ghost', 'deeper');
      await input.evaluate((element, value) => {
        (element as HTMLInputElement).value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, stalePath);
      await input.click();
      await browserExpect(browser.getByRole('textbox', { name: 'Filter directories...' })).toHaveValue('ghost');
      await browserExpect(browser.locator('[aria-current="location"]')).toHaveText('alpha');
      await browserExpect(control('Create directory "ghost"')).toBeVisible();
      await control('Cancel').click();
      await browserExpect(browser).toHaveCount(0);
      await browserExpect(input).toHaveValue(stalePath);

      phase('desktop popover follows the typed path and creates from it');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.detach();
      await page.setViewportSize({ width: 1280, height: 800 });
      await openNewChat();
      await input.fill(join(root, 'al'));
      await browserExpect(control('alpha')).toBeVisible();
      await browserExpect(control('beta')).toHaveCount(0);
      await input.press('ArrowDown');
      await browserExpect(control('alpha')).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await browserExpect(input).toBeFocused();
      await control('alpha').click();
      await browserExpect(input).toHaveValue(join(root, 'alpha'));
      await browserExpect(control('nested')).toBeVisible();
      await browserExpect(control('touch created')).toBeVisible();
      await input.fill(join(root, 'alpha', 'desk'));
      await browserExpect(control('nested')).toHaveCount(0);
      await control('Create directory "desk"').click();
      const deskName = browser.getByRole('textbox', { name: 'Directory name' });
      await browserExpect(deskName).toHaveValue('desk');
      await deskName.fill('desktop created');
      await screenshot('popover-create');
      await page.keyboard.press('Escape');
      await browserExpect(deskName).toHaveCount(0);
      await browserExpect(browser).toBeVisible();
      await control('New directory').click();
      await deskName.fill('desktop created');
      await deskName.press('Enter');
      const desktopCreated = join(root, 'alpha', 'desktop created');
      await browserExpect(input).toHaveValue(desktopCreated);
      await browserExpect(input).toBeFocused();
      await browserExpect(browser.getByText('No subdirectories')).toBeVisible();
      expect((await stat(desktopCreated)).isDirectory()).toBe(true);

      const executorId = integration.client.executorId;
      expect(creations).toEqual([
        `${executorId} ${join(root, 'alpha')} {"name":"touch created"}`,
        `${executorId} ${join(root, 'alpha')} {"name":"desktop created"}`,
      ]);
      expect((await readdir(join(root, 'alpha'))).sort()).toEqual(['desktop created', 'nested', 'notes', 'touch created']);
      if (executionBackend !== 'in-process') expect(await readdir(integration.dirs.project)).toEqual([]);
      expect((await integration.client.listChats()).sessions).toEqual([]);
      // Listing the stale path and its missing parent are the only requests expected to fail.
      expect(failedResponses.map((response) => {
        const [status, method, url] = response.split(' ');
        return `${status} ${method} ${new URL(url!).pathname} ${new URL(url!).searchParams.get('path')}`;
      })).toEqual([stalePath, join(root, 'alpha', 'ghost')].map((path) => `404 GET /api/v1/files/browse ${path}`));
      expect(browserErrors.filter((error) => !error.includes('status of 404'))).toEqual([]);
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 120_000);
}
