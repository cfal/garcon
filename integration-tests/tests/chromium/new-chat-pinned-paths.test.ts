import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('New Chat reconciles live bookmarks and retains disabled pins after executor removal', async () => {
  await withChromiumFixture('new-chat-live-pinned-paths', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, dirs } = integration;
    const executor = await client.post<{ id: string }>('/api/v1/executors', {
      label: 'Synthetic worker', direction: 'executor-connects',
    });
    const localPins = [dirs.project, ...Array.from({ length: 7 }, (_, index) => `/synthetic/project-${index}`)];
    const remotePath = '/synthetic/Space Project ';
    await client.put('/api/v1/app/settings', { paths: {
      pinnedProjectPaths: localPins,
      byExecutor: { [executor.id]: { defaultPath: '/synthetic/default', pinnedPaths: [remotePath] } },
    } });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    const prompt = page.getByPlaceholder('How can I help you today?');
    await prompt.fill('Synthetic retained draft');
    await page.getByRole('button', { name: 'All machines', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: `Synthetic worker: ${remotePath.trim()}`, exact: true })).toBeDisabled();
    await client.delete(`/api/v1/executors/${executor.id}`);
    const removedPin = page.getByRole('button', { name: `${executor.id}: ${remotePath.trim()}`, exact: true });
    await browserExpect(removedPin).toBeDisabled();
    await browserExpect(removedPin).toHaveAccessibleDescription('Unavailable executor');
    const snapshot = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    expect(snapshot.paths.byExecutor?.[executor.id]).toEqual({ recentPaths: [], pinnedPaths: [remotePath] });

    const search = page.getByRole('searchbox', { name: 'Search pinned paths' });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const before = await search.boundingBox();
      await search.fill('no-match');
      await browserExpect(page.getByText('No pinned paths match your search.')).toBeVisible();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const after = await search.boundingBox();
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
      await page.getByRole('button', { name: 'Clear pinned path search' }).click();
      await browserExpect(search).toBeFocused();
      await browserExpect(removedPin).toBeDisabled();
    }

    await page.getByRole('button', { name: 'This machine', exact: true }).click();
    const replacement = '/synthetic/replacement';
    await client.put('/api/v1/app/settings', { paths: { pinnedProjectPaths: [replacement] } });
    await browserExpect(page.getByRole('button', { name: replacement, exact: true })).toBeVisible();
    await browserExpect(page.getByRole('button', { name: dirs.project, exact: true })).toHaveCount(0);
    await browserExpect(page.getByRole('button', { name: 'Pin project path', exact: true })).toBeVisible();
    await browserExpect(prompt).toHaveValue('Synthetic retained draft');
    expect((await client.listChats()).sessions).toEqual([]);
    assertNoBrowserErrors();
  });
}, 120_000);
