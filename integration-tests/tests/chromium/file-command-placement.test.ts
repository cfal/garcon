import { expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('opens a known file in the split window where the palette was invoked', async () => {
  await withChromiumFixture('file-command-placement', async (fixture) => {
    const { page, integration } = fixture;
    await writeFile(join(integration.dirs.project, 'first.md'), '# First file\n', 'utf8');
    await writeFile(join(integration.dirs.project, 'second.md'), '# Second file\n', 'utf8');
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId,
      content: 'File command placement fixture',
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await page.locator('[data-file-tree-entry-text]').filter({ hasText: 'first.md' }).click();
    const first = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]').filter({
      has: page.getByRole('heading', { name: 'First file', exact: true }),
    });
    await first.waitFor({ state: 'visible' });
    const originWindow = await first.evaluate((element) =>
      element.closest('[data-workspace-window-id]')?.getAttribute('data-workspace-window-id'),
    );
    expect(originWindow).toBe('window-files');
    await first.getByRole('region', { name: 'first.md', exact: true }).click();
    await page.keyboard.press('Control+p');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByRole('combobox').fill('second.md');
    await palette.getByRole('option', { name: 'Open second.md Known file File' }).click();
    const second = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]').filter({
      has: page.getByRole('heading', { name: 'Second file', exact: true }),
    });
    await second.waitFor({ state: 'visible' });
    expect(
      await second.evaluate((element) =>
        element
          .closest('[data-workspace-window-id]')
          ?.getAttribute('data-workspace-window-id'),
      ),
    ).toBe(originWindow);
    fixture.assertNoBrowserErrors();
  });
}, 180_000);
