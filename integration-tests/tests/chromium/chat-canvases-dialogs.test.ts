import { expect, test } from 'bun:test';
import type { ChatCanvas, CanvasContent } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const endpoint = '/api/v1/chat-canvases';

test('suspends every Canvas modal when Chat activates and retains unfinished input', async () => {
  await withChromiumFixture(
    'canvas-hidden-dialogs',
    async (fixture, markPhase) => {
      const { page, integration } = fixture;
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'canvas-dialog-synthetic',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await integration.client.post(endpoint, {
        id: 'diagram',
        content: {
          title: 'Diagram',
          nodes: [
            {
              id: 'source',
              type: 'box',
              title: 'Source',
              position: { x: 0, y: 0 },
            },
            {
              id: 'target',
              type: 'box',
              title: 'Target',
              position: { x: 500, y: 0 },
            },
          ],
          connections: [],
        },
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
        waitUntil: 'domcontentloaded',
      });
      await page
        .locator(
          '[data-workspace-window-current="true"] [data-workspace-window-add-trigger]',
        )
        .click();
      await page
        .getByRole('menuitem', { name: 'Open canvas', exact: true })
        .click();
      const dialog = page.getByRole('dialog');
      for (const action of [
        'Rename canvas',
        'Add box',
        'Add chats',
        'Connect',
        'Delete canvas',
      ]) {
        markPhase(`suspending ${action}`);
        await page.getByRole('button', { name: action, exact: true }).click();
        if (action === 'Rename canvas' || action === 'Add box')
          await dialog.getByRole('textbox').fill('Unsubmitted title');
        if (action === 'Add chats')
          await dialog.getByRole('checkbox').first().check();
        if (action === 'Connect') {
          await dialog.getByLabel(/^From/).selectOption('source');
          await dialog.getByLabel(/^To/).selectOption('target');
          await dialog
            .getByLabel('Connection label', { exact: true })
            .fill('Unsubmitted label');
        }
        // External navigation can activate a retained tab while its modal is open.
        await page
          .locator('[role="tab"][aria-controls*="-panel-chat-view:"]')
          .evaluate((tab) => (tab as HTMLElement).click());
        await dialog.waitFor({ state: 'hidden' });
        expect(await page.locator('[data-canvas-panel]').isVisible()).toBe(
          false,
        );
        expect(await page.locator('[data-slot="dialog-overlay"]').count()).toBe(
          0,
        );
        await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
        await dialog.waitFor({ state: 'visible' });
        if (action === 'Rename canvas' || action === 'Add box')
          expect(await dialog.getByRole('textbox').inputValue()).toBe(
            'Unsubmitted title',
          );
        if (action === 'Add chats')
          expect(await dialog.getByRole('checkbox').first().isChecked()).toBe(
            true,
          );
        if (action === 'Connect') {
          expect(await dialog.getByLabel(/^From/).inputValue()).toBe('source');
          expect(await dialog.getByLabel(/^To/).inputValue()).toBe('target');
          expect(
            await dialog
              .getByLabel('Connection label', { exact: true })
              .inputValue(),
          ).toBe('Unsubmitted label');
        }
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      }
      fixture.assertNoBrowserErrors();
    },
  );
}, 120_000);

test('keeps stale rename, selected-chat, and full-connection drafts reviewable', async () => {
  await withChromiumFixture(
    'canvas-stale-form-drafts',
    async (fixture, markPhase) => {
      const { page, integration } = fixture;
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: 'canvas-stale-form-synthetic',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      const content: CanvasContent = {
        title: 'Diagram',
        nodes: [
          {
            id: 'source',
            type: 'box',
            title: 'Source',
            position: { x: 0, y: 0 },
          },
          {
            id: 'target',
            type: 'box',
            title: 'Target',
            position: { x: 500, y: 0 },
          },
        ],
        connections: [],
      };
      await integration.client.post(endpoint, { id: 'diagram', content });
      await page.goto(integration.garcon.baseUrl, {
        waitUntil: 'domcontentloaded',
      });
      await page
        .locator(
          '[data-workspace-window-current="true"] [data-workspace-window-add-trigger]',
        )
        .click();
      await page
        .getByRole('menuitem', { name: 'Open canvas', exact: true })
        .click();
      const dialog = page.getByRole('dialog');
      markPhase('renaming a box removed remotely');
      await page.locator('.svelte-flow__node[data-id="source"]').click();
      await page
        .getByRole('button', { name: 'Rename box', exact: true })
        .click();
      await dialog.getByRole('textbox').fill('Preserve this title');
      await integration.client.put(endpoint, {
        id: 'diagram',
        expectedRevision: 1,
        content: { ...content, nodes: content.nodes.slice(1) },
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page
        .locator('.svelte-flow__node[data-id="source"]')
        .waitFor({ state: 'detached' });
      await dialog.getByRole('textbox').press('Enter');
      await dialog.getByRole('alert').waitFor();
      expect(await dialog.getByRole('textbox').inputValue()).toBe(
        'Preserve this title',
      );
      await page.keyboard.press('Escape');
      markPhase('deleting a selected picker chat');
      await page
        .getByRole('button', { name: 'Add chats', exact: true })
        .click();
      await dialog.getByRole('checkbox').first().check();
      await integration.client.deleteChat(chatId);
      await dialog.getByRole('checkbox').waitFor({ state: 'detached' });
      expect(
        await dialog
          .getByRole('button', { name: 'Add selected chats', exact: true })
          .isDisabled(),
      ).toBe(true);
      await dialog.getByRole('searchbox').press('Enter');
      expect(await dialog.isVisible()).toBe(true);
      await page.keyboard.press('Escape');
      markPhase('reaching the connection limit while a label is pending');
      await integration.client.put(endpoint, {
        id: 'diagram',
        expectedRevision: 2,
        content,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page
        .locator('.svelte-flow__node[data-id="source"]')
        .waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await dialog.getByLabel(/^From/).selectOption('source');
      await dialog.getByLabel(/^To/).selectOption('target');
      await dialog
        .getByLabel('Connection label', { exact: true })
        .fill('Preserve this label');
      const full = {
        ...content,
        connections: Array.from({ length: 2000 }, (_, i) => ({
          id: `edge-${i}`,
          source: 'source',
          target: 'target',
          sourceSide: 'right' as const,
          targetSide: 'left' as const,
          label: '',
        })),
      };
      await integration.client.put(endpoint, {
        id: 'diagram',
        expectedRevision: 3,
        content: full,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(
        () => document.querySelectorAll('.svelte-flow__edge').length === 2000,
      );
      expect(
        await dialog
          .getByRole('button', { name: 'Connect', exact: true })
          .isDisabled(),
      ).toBe(true);
      await dialog
        .getByLabel('Connection label', { exact: true })
        .press('Enter');
      expect(
        await dialog
          .getByLabel('Connection label', { exact: true })
          .inputValue(),
      ).toBe('Preserve this label');
      expect(
        (await integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`))
          .content,
      ).toEqual(full);
      fixture.assertNoBrowserErrors();
    },
  );
}, 120_000);
