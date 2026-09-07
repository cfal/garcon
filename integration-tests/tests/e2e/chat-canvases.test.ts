import { describe, expect, test } from 'bun:test';
import type {
  ChatCanvas,
  CanvasListResponse,
} from '../../../common/chat-canvas.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const endpoint = '/api/v1/chat-canvases';

describe('Lightpanda Chat Canvas', () => {
  test('creates a board, groups live chats, and retains edits after reload', async () => {
    await withE2eFixture('chat-canvas-editing', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('canvas-synthetic-chat');
      await app.waitForText('echo:canvas-synthetic-chat');
      const chat = (await fixture.integration.client.listChats()).sessions.find(
        (entry) => entry.preview.firstMessage === 'canvas-synthetic-chat',
      );
      if (!chat) throw new Error('Synthetic chat was not listed');
      await app.selectWorkspaceWindowSurface('Open chat map');
      await app.waitForText('Canvases');
      await app.clickButton('Canvases');
      await fixture.page.waitForSelector('[data-canvas-panel]');
      await app.waitForText('Create canvas');
      await app.clickButton('Create canvas');
      await app.fill('[role="dialog"] input', 'Project diagram');
      await app.clickButton('Apply');
      await fixture.page.waitForFunction(
        () => !document.querySelector('[role="dialog"]'),
      );
      await fixture.page.waitForSelector('[data-canvas-flow]');
      await app.clickButton('List');
      for (const title of ['Research', 'Implementation']) {
        await app.clickButton('Add box');
        await app.fill('[role="dialog"] input', title);
        await app.clickButton('Apply');
        await fixture.page.waitForFunction(
          () => !document.querySelector('[role="dialog"]'),
        );
        await fixture.page.waitForFunction(
          ({ selector, text }) =>
            document.querySelector(selector)?.textContent?.includes(text),
          {},
          { selector: '[data-canvas-list]', text: title },
        );
      }
      await app.clickButton('Add chats');
      await fixture.page.waitForSelector(
        '[role="dialog"] input[type="checkbox"]',
      );
      await fixture.page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')!;
        dialog
          .querySelector<HTMLInputElement>('input[type="checkbox"]')!
          .click();
      });
      await app.clickButton('Add selected chats');
      await fixture.page.waitForSelector('[data-canvas-list] li button');
      await app.clickButton('Undo');
      await fixture.page.waitForFunction(
        () =>
          !document.querySelector('[data-canvas-list] [data-canvas-chat-card]'),
      );
      await app.clickButton('Redo');
      await fixture.page.waitForFunction(
        ({ selector, text }) =>
          document.querySelector(selector)?.textContent?.includes(text),
        {},
        { selector: '[data-canvas-panel] [role="status"]', text: 'Saved' },
      );
      const catalog =
        await fixture.integration.client.get<CanvasListResponse>(endpoint);
      expect(catalog.canvases).toHaveLength(1);
      const board = await fixture.integration.client.get<ChatCanvas>(
        `${endpoint}?id=${catalog.canvases[0].id}`,
      );
      expect(board.content.title).toBe('Project diagram');
      const box = board.content.nodes.find(
        (node) => node.type === 'box' && node.title === 'Implementation',
      )!;
      expect(
        board.content.nodes.find((node) => node.type === 'chat'),
      ).toMatchObject({ chatId: chat.id, boxId: box.id });

      await fixture.page.reload({ waitUntil: [] });
      await fixture.page.waitForSelector(
        '[data-workspace-window-current="true"]',
      );
      await app.selectWorkspaceWindowSurface('Chat Map');
      await app.waitForText('Canvases');
      await app.clickButton('Canvases');
      await fixture.page.waitForSelector('[data-canvas-flow]');
      await app.clickButton('List');
      await fixture.page.waitForFunction(
        ({ selector, text }) =>
          document.querySelector(selector)?.textContent?.includes(text),
        {},
        { selector: '[data-canvas-list]', text: 'canvas-synthetic-chat' },
      );
      await app.clickButton('Open chat', { last: true });
      await app.waitForSelectedChat(chat.id);
      fixture.assertNoBrowserErrors();
    });
  });
});
