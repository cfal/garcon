import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`opens and revision-saves a workflow file without a chat (${executionBackend})`, async () => {
    await withChromiumFixture(`workflow-file-${executionBackend}`, async ({ page, integration, assertNoBrowserErrors }) => {
      const path = join(integration.executionDirs.project, 'review.workflow.yaml');
      const source = 'version: 1\nname: Clean file\nsteps:\n  - {id: review, kind: decision, prompt: "Ready?", choices: {ok: Approve}}\n';
      await writeFile(path, source);
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Workflow', exact: true }).click();
      const studio = page.getByRole('region', { name: 'New Workflow', exact: true });
      await studio.getByRole('button', { name: 'Definition editor' }).click();
      await studio.getByRole('button', { name: 'Open source file' }).click();
      const picker = page.getByRole('dialog', { name: 'Open source file' });
      if (executionBackend !== 'in-process') {
        await picker.locator('[data-executor-picker]').click();
        await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
      }
      await picker.getByLabel('File path').fill(path);
      await picker.getByRole('button', { name: 'Open source file' }).click();
      const heading = studio.getByRole('heading', { name: 'Clean file' });
      await browserExpect(heading).toBeVisible();
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(heading).toBeVisible();
      }
      await studio.getByLabel('Definition name').fill('Revised file');
      await studio.getByRole('button', { name: 'Apply name' }).click();
      const save = studio.getByRole('button', { name: 'Save draft file' });
      await save.click();
      await browserExpect(save).toBeDisabled();
      await browserExpect.poll(() => readFile(path, 'utf8')).toContain('name: "Revised file"');
      expect((await integration.client.listChats()).sessions).toEqual([]);
      assertNoBrowserErrors();
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}
