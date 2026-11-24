import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreamblesMutationResponse, PreamblesSnapshot } from '../../../common/preambles.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`session tags and preambles replace their placeholders inside matching fields (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-session-options-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client } = integration;
      const catalog = await client.get<PreamblesSnapshot>('/api/v1/preambles');
      await client.post<PreamblesMutationResponse>('/api/v1/preambles', {
        expectedRevision: catalog.revision,
        preamble: { enabled: true, title: 'Project conventions', content: 'Synthetic project instructions.', scope: { type: 'global' } },
      });
      await client.put('/api/v1/app/settings', { paths: client.executorId === 'local'
        ? { recentProjectPaths: [integration.executionDirs.project] }
        : { byExecutor: { [client.executorId]: { defaultPath: integration.executionDirs.project, pinnedPaths: [integration.executionDirs.project] } } },
      });
      await page.addInitScript(seedLocalSettings, { composerStatusBarGitProjects: false, composerStatusBarNonGitProjects: false });
      await page.goto(integration.garcon.baseUrl);
      const dialog = page.getByRole('dialog', { name: 'New Chat', exact: true });
      await browserExpect(dialog).toBeVisible();
      if (client.executorId !== 'local') {
        await dialog.getByRole('button', { name: `Integration worker: ${integration.executionDirs.project}`, exact: true }).click();
      }
      const prompt = dialog.getByPlaceholder('How can I help you today?');
      await prompt.fill('Review the compact session fields.');
      const tags = dialog.locator('[data-slot="new-chat-tags-row"]');
      const preambles = dialog.locator('[data-slot="new-chat-preambles-row"]');
      phase('replacing preamble placeholder copy with selected pills');
      await browserExpect(preambles.getByText('Project conventions', { exact: true })).toBeVisible();
      await browserExpect(preambles.getByText('Add preambles to session', { exact: true })).toHaveCount(0);
      await preambles.getByRole('button', { name: 'Clear preambles', exact: true }).click();
      await browserExpect(preambles.getByText('Add preambles to session', { exact: true })).toBeVisible();
      await preambles.getByRole('button', { name: 'Edit preambles', exact: true }).click();
      const picker = page.locator('[data-slot="new-chat-preamble-selection-dialog"]');
      await picker.getByRole('switch', { name: 'Add Project conventions', exact: true }).click();
      await picker.getByRole('button', { name: 'Apply', exact: true }).click();
      await browserExpect(preambles.getByText('Project conventions', { exact: true })).toBeVisible();
      await browserExpect(preambles.getByText('Add preambles to session', { exact: true })).toHaveCount(0);
      phase('adding and editing tags inside the field');
      await browserExpect(tags.getByText('Add tags to session', { exact: true })).toBeVisible();
      const addTags = tags.getByRole('button', { name: 'Add tags to session', exact: true });
      await addTags.click();
      const tagInput = tags.getByPlaceholder('Type a tag...');
      for (const tag of ['review', 'design', 'ready']) {
        await tagInput.fill(tag);
        await tagInput.press('Enter');
        await browserExpect(tags.getByRole('button', { name: `Remove tag ${tag}`, exact: true })).toBeVisible();
      }
      await browserExpect(tags.getByText('Add tags to session', { exact: true })).toHaveCount(0);
      phase('closing the preamble picker before the open tag editor');
      const editPreambles = preambles.getByRole('button', { name: 'Edit preambles', exact: true });
      await editPreambles.click();
      await browserExpect(picker).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(tagInput).toBeVisible();
      await browserExpect(editPreambles).toBeFocused();
      await browserExpect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(tagInput).toHaveCount(0);
      await browserExpect(addTags).toBeFocused();
      await browserExpect(dialog).toBeVisible();
      await browserExpect(tags.getByRole('button', { name: 'Remove tag review', exact: true })).toBeVisible();
      await browserExpect(preambles.getByText('Project conventions', { exact: true })).toBeVisible();
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      for (const width of [1440, 390, 360]) {
        phase(`checking selected option fields at ${width}px`);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: width < 500 });
        await page.setViewportSize({ width, height: 900 });
        await browserExpect.poll(() => tags.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        const tagBounds = (await tags.boundingBox())!;
        const preambleBounds = (await preambles.boundingBox())!;
        expect(tagBounds.width).toBeCloseTo(preambleBounds.width, 0);
        expect(tagBounds.height).toBeCloseTo(preambleBounds.height, 0);
        for (const pill of await tags.getByRole('button', { name: /^Remove tag / }).all()) {
          const bounds = (await pill.boundingBox())!;
          expect(bounds.y).toBeGreaterThanOrEqual(tagBounds.y);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(tagBounds.y + tagBounds.height);
        }
        await page.screenshot({ path: join(artifacts, `session-options-${executionBackend}-${width}.png`) });
        await cdp.detach();
      }
      phase('containing long tags and keeping touch input legible');
      const touchSession = await context.newCDPSession(page);
      await touchSession.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await browserExpect.poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await addTags.click();
      await browserExpect(tagInput).toBeFocused();
      expect(await tagInput.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      const longTag = Array(20).fill('synthetic').join('-');
      await tagInput.fill(longTag);
      await tagInput.press('Enter');
      await browserExpect(tags.getByRole('button', { name: `Remove tag ${longTag}`, exact: true })).toBeVisible();
      expect(await tags.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await tagInput.press('Backspace');
      await browserExpect(tags.getByRole('button', { name: `Remove tag ${longTag}`, exact: true })).toHaveCount(0);
      await tagInput.press('Escape');
      await touchSession.detach();
      phase('restoring placeholders after clearing selections');
      for (const tag of ['review', 'design', 'ready']) {
        await tags.getByRole('button', { name: `Remove tag ${tag}`, exact: true }).click();
      }
      await browserExpect(tags.getByText('Add tags to session', { exact: true })).toBeVisible();
      await preambles.getByRole('button', { name: 'Clear preambles', exact: true }).click();
      await browserExpect(preambles.getByText('Add preambles to session', { exact: true })).toBeVisible();
      await browserExpect(prompt).toHaveValue('Review the compact session fields.');
      expect((await client.listChats()).sessions).toEqual([]);
      assertNoBrowserErrors();
    }, undefined, { executionBackend });
  }, 120_000);
}
