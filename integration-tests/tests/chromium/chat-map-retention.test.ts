import { test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRegistrySnapshot } from '../../../server/controller/chats/registry-contracts.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction } from '../../support/chromium-workspace.js';

test('restores both scroll axes of a deep Chat Map across repeated renderer releases', async () => {
  await withChromiumFixture('chat-map-scroll-retention', async (fixture) => {
    const { page, integration } = fixture;
    const ids: string[] = [];
    for (let index = 0; index < 18; index++) {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: `Synthetic map item ${index}`,
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      ids.push(chatId);
    }
    await integration.restartGarcon({ beforeStart: async () => {
      const path = join(integration.dirs.workspace, 'chats.json');
      const registry: ChatRegistrySnapshot = await Bun.file(path).json();
      for (let index = 1; index < ids.length; index++) {
        const id = ids[index]!;
        registry.sessions[id] = {
          ...registry.sessions[id]!,
          parentChat: { relation: 'delegation', chatId: ids[index - 1]! },
        };
      }
      await writeFile(path, JSON.stringify(registry));
    } });
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
    await clickWorkspaceWindowAddAction(page, 'Open Chat Map');
    const region = page.locator('[data-chat-map-scroll-region]');
    await browserExpect(region).toBeVisible();
    await browserExpect.poll(() => region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(80);
    const windowId = await region.evaluate((element) => element.closest('[data-workspace-window-id]')!.getAttribute('data-workspace-window-id')!);
    for (const [top, left] of [[120, 80], [60, 40]]) {
      await region.evaluate((element, position) => element.scrollTo(position), { top, left });
      await browserExpect.poll(() => region.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([top, left]);
      if (top === 120) await clickWorkspaceWindowAddAction(page, 'Open Canvas', windowId);
      else await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
      await browserExpect(region).toHaveCount(0);
      await page.getByRole('tab', { name: 'Chat Map', exact: true }).click();
      await browserExpect(region).toBeVisible();
      await browserExpect.poll(() => region.evaluate((element) => [element.scrollTop, element.scrollLeft])).toEqual([top, left]);
    }
    fixture.assertNoBrowserErrors();
  });
}, 180_000);
