import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`saves a workflow file without a chat and requires comparison after an external edit (${executionBackend})`, async () => {
    await withChromiumFixture(`workflow-file-${executionBackend}`, async ({ page, integration, withExpectedConsoleErrors }) => {
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
      const mobile = page.locator('#mobile-panel-new-workflow');
      await page.setViewportSize({ width: 390, height: 900 });
      await browserExpect(mobile.getByRole('heading', { name: 'Clean file' })).toBeVisible();
      await page.setViewportSize({ width: 1440, height: 900 });
      await browserExpect(mobile).toBeHidden();
      await browserExpect(heading).toBeVisible();
      const rename = async (name: string) => {
        await studio.getByLabel('Definition name').fill(name);
        await studio.getByRole('button', { name: 'Apply name' }).click();
      };
      await rename('Revised file');
      const save = studio.getByRole('button', { name: 'Save draft file' });
      const unsaved = studio.getByText(/Unsaved changes/);
      await browserExpect(unsaved).toBeVisible();
      await save.click();
      await browserExpect(unsaved).toHaveCount(0);
      await browserExpect(save).toBeDisabled();
      expect(await readFile(path, 'utf8')).toContain('name: "Revised file"');

      const external = source.replace('Clean file', 'External revision');
      await writeFile(path, external);
      await rename('Retained draft');
      await withExpectedConsoleErrors(['Failed to load resource: the server responded with a status of 409 (Conflict)'], async () => {
        await save.click();
        await browserExpect(studio.getByRole('alert')).toContainText('Compare with disk before saving again');
      });
      await browserExpect(save).toHaveCount(0);
      expect(await readFile(path, 'utf8')).toBe(external);
      await studio.getByRole('button', { name: 'Compare with disk' }).click();
      const comparison = studio.getByRole('tabpanel', { name: 'Disk' });
      await browserExpect(comparison).toContainText('External revision');
      await browserExpect(comparison).toContainText('Retained draft');
      await studio.getByRole('button', { name: 'Save against displayed disk' }).click();
      await browserExpect(unsaved).toHaveCount(0);
      expect(await readFile(path, 'utf8')).toBe(source.replace('name: Clean file', 'name: "Retained draft"'));
      expect((await integration.client.listChats()).sessions).toEqual([]);
    }, undefined, { executionBackend, projectRoots: 'separate' });
  }, 90_000);
}
