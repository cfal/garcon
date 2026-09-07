import { expect, test } from 'bun:test';
import type { ChatCanvas, CanvasContent } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const endpoint = '/api/v1/chat-canvases';

test('revalidates connection endpoints and chat destinations after remote edits', async () => {
  await withChromiumFixture('canvas-form-refresh', async (fixture) => {
    const { page, integration } = fixture;
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId, content: 'canvas-form-synthetic', projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    const content: CanvasContent = {
      title: 'Diagram',
      nodes: [
        { id: 'source', type: 'box', title: 'Source', position: { x: 0, y: 0 } },
        { id: 'target', type: 'box', title: 'Target', position: { x: 500, y: 0 } },
      ],
      connections: [],
    };
    await integration.client.post(endpoint, { id: 'diagram', content });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]').click();
    await page.getByRole('menuitem', { name: 'Open canvas', exact: true }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^From/).selectOption('source');
    await dialog.getByLabel(/^To/).selectOption('target');
    await integration.client.put(endpoint, {
      id: 'diagram', expectedRevision: 1, content: { ...content, nodes: content.nodes.slice(0, 1) },
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector('[role="dialog"] option[value="target"]'));
    expect(await dialog.getByRole('button', { name: 'Connect', exact: true }).isDisabled()).toBe(true);
    await dialog.getByLabel('Connection label', { exact: true }).press('Enter');
    expect(await dialog.count()).toBe(1);
    expect((await integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`)).content.connections).toHaveLength(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add chats', exact: true }).click();
    await dialog.getByRole('combobox').selectOption('source');
    await dialog.getByRole('checkbox').first().check();
    await integration.client.put(endpoint, {
      id: 'diagram', expectedRevision: 2, content: { ...content, nodes: [] },
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => !document.querySelector('[role="dialog"] option[value="source"]'));
    expect(await dialog.getByRole('button', { name: 'Add selected chats', exact: true }).isDisabled()).toBe(true);
    await dialog.getByRole('searchbox').press('Enter');
    expect(await dialog.count()).toBe(1);
    await dialog.getByRole('combobox').selectOption('');
    await dialog.getByRole('button', { name: 'Add selected chats', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-canvas-panel] [role="status"]')?.textContent === 'Saved');
    expect((await integration.client.get<ChatCanvas>(`${endpoint}?id=diagram`)).content.nodes).toMatchObject([
      { type: 'chat', chatId, boxId: null },
    ]);
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
