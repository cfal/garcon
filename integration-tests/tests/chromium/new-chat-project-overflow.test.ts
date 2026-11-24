import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

for (const executionBackend of ['in-process', 'remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`New Chat promotes overflow projects and replaces the oldest machine pin (${executionBackend})`, async () => {
    await withChromiumFixture(`new-chat-project-overflow-${executionBackend}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
      const { client, executionDirs } = integration;
      const paths = Array.from({ length: 8 }, (_, index) => join(executionDirs.project, `project-${index + 1}`));
      await Promise.all(paths.map(path => mkdir(path, { recursive: true })));
      const offline = await client.post<{ id: string }>('/api/v1/executors', {
        label: 'Offline machine', direction: 'executor-connects', noTls: true,
      });
      await client.put('/api/v1/app/settings', { paths: {
        ...(client.executorId === 'local' ? {
          pinnedProjectPaths: paths, recentProjectPaths: paths, browseStartPath: paths[0],
        } : {
          pinnedProjectPaths: ['/synthetic/local-one', '/synthetic/local-two'],
        }),
        byExecutor: {
          ...(client.executorId === 'local' ? {} : { [client.executorId]: { defaultPath: paths[0], pinnedPaths: paths } }),
          [offline.id]: { pinnedPaths: ['/synthetic/offline-project'] },
        },
      } });
      await page.addInitScript(seedLocalSettings, { composerStatusBarGitProjects: false, composerStatusBarNonGitProjects: false });
      await page.goto(integration.garcon.baseUrl);
      const dialog = page.getByRole('dialog', { name: 'New Chat', exact: true });
      await browserExpect(dialog).toBeVisible();
      const projects = dialog.getByRole('region', { name: 'Saved and recent projects', exact: true });
      const primary = projects.locator('[data-slot="new-chat-project-select"]');
      const more = projects.getByRole('button', { name: 'More', exact: true });
      const overflow = page.locator('[data-slot="new-chat-more-projects"]');
      const prompt = dialog.getByPlaceholder('How can I help you today?');
      await prompt.fill('Synthetic overflow selection draft');
      await browserExpect(dialog.getByText('Add preambles to session', { exact: true })).toBeVisible();
      phase('checking the five-card limit and offline filtering');
      await browserExpect(primary).toHaveCount(5);
      await browserExpect(projects.getByRole('button', { name: /Offline machine/ })).toHaveCount(0);
      expect(await projects.locator('[data-slot="new-chat-project-list"]').evaluate(element =>
        !['auto', 'scroll'].includes(getComputedStyle(element).overflowY))).toBe(true);
      await more.click();
      await browserExpect(overflow).toBeVisible();
      await browserExpect(overflow.getByRole('button', { name: /^Project actions:/ })).toHaveCount(0);
      const moreBounds = (await more.boundingBox())!;
      const popupBounds = (await overflow.boundingBox())!;
      expect(popupBounds.y).toBeGreaterThanOrEqual(moreBounds.y + moreBounds.height);
      expect(popupBounds.width).toBeCloseTo(moreBounds.width, 0);
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `project-more-${executionBackend}-1440.png`) });
      phase('closing More before New Chat with Escape and outside click');
      await page.keyboard.press('Escape');
      await browserExpect(overflow).toHaveCount(0);
      await browserExpect(dialog).toBeVisible();
      await more.click();
      await prompt.click();
      await browserExpect(overflow).toHaveCount(0);
      await browserExpect(dialog).toBeVisible();
      phase('promoting an overflow selection without losing its draft');
      const previousOrder = await primary.evaluateAll(elements => elements.map(element => element.getAttribute('title')));
      await more.click();
      const selectedPath = paths[1]!;
      await overflow.getByRole('button', { name: client.executorId === 'local' ? selectedPath : `Integration worker: ${selectedPath}`, exact: true }).click();
      await browserExpect(overflow).toHaveCount(0);
      await browserExpect(primary.first()).toHaveAttribute('title', selectedPath);
      await browserExpect(primary.first()).toHaveAttribute('aria-pressed', 'true');
      expect(await primary.evaluateAll(elements => elements.map(element => element.getAttribute('title')))).toEqual([selectedPath, ...previousOrder.slice(0, 4)]);
      await browserExpect(prompt).toHaveValue('Synthetic overflow selection draft');
      const card = primary.first().locator('..');
      await card.getByRole('button', { name: /^Project actions:/ }).click();
      await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
      await browserExpect(card.getByRole('img', { name: 'Pinned', exact: true })).toBeVisible();
      const saved = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
      const pins = client.executorId === 'local' ? saved.paths.pinnedProjectPaths : saved.paths.byExecutor?.[client.executorId]?.pinnedPaths;
      const recents = client.executorId === 'local' ? saved.paths.recentProjectPaths : saved.paths.byExecutor?.[client.executorId]?.recentPaths;
      expect(pins).toEqual([...paths.slice(4), selectedPath]);
      expect(recents).toContain(paths[3]!);
      if (client.executorId !== 'local') expect(saved.paths.pinnedProjectPaths).toEqual(['/synthetic/local-one', '/synthetic/local-two']);
      await browserExpect(primary).toHaveCount(5);
      phase('checking the floating menu at mobile width');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await page.setViewportSize({ width: 390, height: 900 });
      await more.click();
      await browserExpect(overflow).toBeVisible();
      expect(await overflow.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: join(artifacts, `project-more-${executionBackend}-390.png`) });
      await page.keyboard.press('Escape');
      await browserExpect(dialog).toBeVisible();
      phase('keeping overflow selection reachable on a short screen');
      await page.setViewportSize({ width: 390, height: 420 });
      await browserExpect(dialog).toHaveCSS('height', '420px');
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await browserExpect(overflow).toBeVisible();
      await overflow.getByRole('button', { name: client.executorId === 'local' ? paths[2]! : `Integration worker: ${paths[2]}`, exact: true }).click();
      await browserExpect(overflow).toHaveCount(0);
      await browserExpect(primary.first()).toHaveAttribute('title', paths[2]!);
      await browserExpect(primary.first()).toHaveAttribute('aria-pressed', 'true');
      await browserExpect(prompt).toHaveValue('Synthetic overflow selection draft');
      await cdp.detach();
      assertNoBrowserErrors();
    }, undefined, { executionBackend });
  }, 120_000);
}
