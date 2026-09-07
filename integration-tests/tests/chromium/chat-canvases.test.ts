import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import type {
  ChatCanvas,
  CanvasContent,
  CanvasListResponse,
} from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

const endpoint = '/api/v1/chat-canvases';
const node = (id: string) => `.svelte-flow__node[data-id="${id}"]`;

async function drag(page: Page, selector: string, dx: number, dy: number) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect) throw new Error(`Missing drag handle ${selector}`);
  const x = rect.x + rect.width / 2;
  const y = rect.y + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}

async function saved(page: Page) {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-canvas-panel] [role="status"]')
        ?.textContent === 'Saved',
  );
}

describe('Chromium Chat Canvas', () => {
  test('moves boxes with their chats, reparents cards, connects handles, and adapts to mobile', async () => {
    await withChromiumFixture(
      'chat-canvas-diagram',
      async (fixture, markPhase) => {
        const { page, integration } = fixture;
        const chatId = integration.newChatId();
        const started = await integration.client.startDirectChat({
          chatId,
          content: 'canvas-synthetic',
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        const content: CanvasContent = {
          title: 'Project diagram',
          nodes: [
            {
              id: 'research',
              type: 'box',
              title: 'Research',
              position: { x: 0, y: 0 },
            },
            {
              id: 'implementation',
              type: 'box',
              title: 'Implementation',
              position: { x: 500, y: 0 },
            },
            {
              id: 'card',
              type: 'chat',
              chatId,
              boxId: 'research',
              position: { x: 0, y: 0 },
            },
          ],
          connections: [],
        };
        await integration.client.post(endpoint, { id: 'diagram', content });
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, {
          waitUntil: 'domcontentloaded',
        });
        await page
          .locator(
            '[data-workspace-window-current="true"] [data-workspace-window-titlebar]',
          )
          .waitFor();
        await collapseCanonicalFilesWindow(page);
        await page
          .locator(
            '[data-workspace-window-current="true"] [data-workspace-window-add-trigger]',
          )
          .click();
        await page.getByRole('menuitem', { name: 'Open chat map' }).click();
        await page
          .getByRole('button', { name: 'Canvases', exact: true })
          .click();
        await page.locator(node('card')).waitFor({ state: 'visible' });
        await page
          .getByRole('button', { name: 'Fit canvas', exact: true })
          .click();
        const zoom = await page
          .locator('.svelte-flow__viewport')
          .evaluate(
            (viewport) => new DOMMatrix(getComputedStyle(viewport).transform).a,
          );
        await page
          .getByRole('button', { name: 'Zoom in', exact: true })
          .click();
        await page.waitForFunction(
          (before) =>
            new DOMMatrix(
              getComputedStyle(
                document.querySelector('.svelte-flow__viewport')!,
              ).transform,
            ).a > before,
          zoom,
        );
        await page
          .getByRole('button', { name: 'Fit canvas', exact: true })
          .click();
        const read = () =>
          integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`);

        markPhase('moving the box and its child');
        const before = await page.locator(node('card')).boundingBox();
        const boxBefore = await page.locator(node('research')).boundingBox();
        await drag(page, `${node('research')} .canvas-drag-handle`, 0, 100);
        await saved(page);
        const after = await page.locator(node('card')).boundingBox();
        const boxAfter = await page.locator(node('research')).boundingBox();
        expect(after!.y - boxAfter!.y).toBeCloseTo(before!.y - boxBefore!.y, 0);
        expect(after!.x - boxAfter!.x).toBeCloseTo(before!.x - boxBefore!.x, 0);
        let board = await read();
        expect(
          board.content.nodes.find((entry) => entry.id === 'research')!.position
            .y,
        ).toBeGreaterThan(50);
        expect(
          board.content.nodes.find((entry) => entry.id === 'card'),
        ).toMatchObject({ boxId: 'research' });

        markPhase('dragging a card between boxes');
        const cardRect = await page.locator(node('card')).boundingBox();
        const boxRect = await page
          .locator(node('implementation'))
          .boundingBox();
        await drag(
          page,
          `${node('card')} .canvas-drag-handle`,
          boxRect!.x + boxRect!.width / 2 - (cardRect!.x + cardRect!.width / 2),
          boxRect!.y + 75 - cardRect!.y,
        );
        await saved(page);
        board = await read();
        expect(
          board.content.nodes.find((entry) => entry.id === 'card'),
        ).toMatchObject({ boxId: 'implementation' });

        markPhase('connecting box handles');
        await page
          .locator(`${node('research')} [data-handleid="right"]`)
          .dragTo(
            page.locator(`${node('implementation')} [data-handleid="left"]`),
          );
        await page.locator('.svelte-flow__edge').waitFor();
        await saved(page);
        expect((await read()).content.connections[0]).toMatchObject({
          source: 'research',
          target: 'implementation',
          sourceSide: 'right',
          targetSide: 'left',
        });

        markPhase('sidebar chat drop stays on the canvas');
        const sidebarRow = page.locator(
          `[data-sidebar-virtual-row="${chatId}"]`,
        );
        await sidebarRow.hover();
        const sourceRect = await sidebarRow.boundingBox();
        const canvasRect = await page
          .locator('[data-canvas-flow]')
          .boundingBox();
        await page.mouse.down();
        await page.mouse.move(
          sourceRect!.x + sourceRect!.width / 2 + 24,
          sourceRect!.y + sourceRect!.height / 2,
          { steps: 4 },
        );
        await page.mouse.move(canvasRect!.x + 40, canvasRect!.y + 300, {
          steps: 20,
        });
        await page.mouse.move(canvasRect!.x + 48, canvasRect!.y + 305, {
          steps: 4,
        });
        await page.mouse.up();
        await page.waitForFunction(
          () =>
            document.querySelectorAll('.svelte-flow__node-canvasChat')
              .length === 2,
        );
        await saved(page);
        expect(
          (await read()).content.nodes.filter((entry) => entry.type === 'chat'),
        ).toHaveLength(2);

        markPhase('opening chats alongside and preserving canvas navigation');
        await page.locator(node('card')).click();
        await page
          .getByRole('button', { name: 'Open alongside', exact: true })
          .click();
        await page.locator('[data-canvas-flow]').waitFor({ state: 'visible' });
        expect(
          await page.locator('[data-workspace-window-id]').count(),
        ).toBeGreaterThan(1);

        markPhase('protecting pending edits while the canvas is hidden');
        let releaseSave!: () => void;
        let saveStarted!: () => void;
        const saveGate = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        const pendingSave = new Promise<void>((resolve) => {
          saveStarted = resolve;
        });
        await page.route(`**${endpoint}*`, async (route) => {
          if (route.request().method() === 'PUT') {
            saveStarted();
            await saveGate;
          }
          await route.continue();
        });
        try {
          await page
            .getByRole('button', { name: 'Rename canvas', exact: true })
            .click();
          await page.getByRole('dialog').getByRole('textbox').fill('Revised diagram');
          await page
            .getByRole('dialog')
            .getByRole('button', { name: 'Apply', exact: true })
            .click();
          await pendingSave;
          await page.getByRole('button', { name: 'Lineage', exact: true }).click();
          expect(
            await page.evaluate(() => {
              const event = new Event('beforeunload', { cancelable: true });
              window.dispatchEvent(event);
              return event.defaultPrevented;
            }),
          ).toBe(true);
        } finally {
          releaseSave();
        }
        await page.getByRole('button', { name: 'Canvases', exact: true }).click();
        await saved(page);
        expect((await read()).content.title).toBe('Revised diagram');
        expect(
          await page.evaluate(() => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          }),
        ).toBe(false);
        await page.unroute(`**${endpoint}*`);

        markPhase('mobile list and form sizing');
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .getByRole('navigation', { name: 'Workspace navigation' })
          .getByRole('button', { name: 'Map', exact: true })
          .click();
        await page.getByRole('button', { name: 'List', exact: true }).click();
        await page.locator('[data-canvas-list]').waitFor({ state: 'visible' });
        const geometry = await page
          .locator('[data-canvas-panel]')
          .evaluate((panel) => ({
            width: panel.getBoundingClientRect().width,
            scrollWidth: panel.scrollWidth,
          }));
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
        await page
          .getByRole('button', { name: 'Add box', exact: true })
          .click();
        expect(
          await page
            .getByRole('dialog')
            .locator('input')
            .evaluate((input) => parseFloat(getComputedStyle(input).fontSize)),
        ).toBeGreaterThanOrEqual(16);
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        markPhase('copying and deleting canvases without deleting chats');
        await page
          .getByRole('button', { name: 'Save as copy', exact: true })
          .click();
        await page
          .getByRole('dialog')
          .getByRole('textbox')
          .fill('Independent copy');
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Apply', exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLSelectElement>(
              '[aria-label="Choose canvas"]',
            )?.selectedOptions[0]?.textContent === 'Independent copy',
        );
        expect(
          (await integration.client.get<CanvasListResponse>(endpoint)).canvases,
        ).toHaveLength(2);
        await page
          .getByRole('button', { name: 'Delete canvas', exact: true })
          .click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Delete canvas', exact: true })
          .click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        expect(
          (await integration.client.get<CanvasListResponse>(endpoint)).canvases,
        ).toHaveLength(1);
        expect(
          (await integration.client.listChats()).sessions.some(
            (chat) => chat.id === chatId,
          ),
        ).toBe(true);
        fixture.assertNoBrowserErrors();
      },
    );
  }, 120_000);
});
