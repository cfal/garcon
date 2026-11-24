import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';

test('retains transcript scroll and keyboard focus when tiling already open chats', async () => {
  await withChromiumFixture('tile-retained-chats', async ({ page, integration }) => {
    const { client, directAgents, fakeProviders } = integration;
    using holds = new DisposableStack();
    for (let i = 0; i < 2; i++) {
      const chatId = integration.newChatId();
      const started = await client.startDirectChat({
        chatId, content: `Chat ${i}\n` + 'A synthetic transcript paragraph.\n\n'.repeat(80),
        projectPath: integration.dirs.project, agent: directAgents.openAi,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      const content = `Hold chat ${i}`;
      const held = fakeProviders.openAi.holdNext({ lastUserText: content });
      await client.runDirectChat({ chatId, content, agent: directAgents.openAi });
      await held.received;
      holds.defer(() => held.releaseEcho());
    }
    const [first, second] = (await client.listChats()).sessions;
    const snapshot = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
      { type: 'set-window-chat', windowId: 'window-main', chatId: second.id },
      { type: 'set-window-chat', windowId: 'window-files', chatId: first.id },
      { type: 'set-partition-ratio', partitionId: 'partition-main', ratio: 0.5 },
    ]);
    await page.addInitScript(layout => localStorage.setItem('workspace_layout_v2', JSON.stringify(layout)),
      serializeWorkspaceLayout(snapshot));
    await page.setViewportSize({ width: 1560, height: 500 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${second.id}`);
    const composer = page.locator('[data-composer] textarea:visible');
    await composer.focus();
    const viewports = page.locator('[data-chat-scroll-viewport]:visible');
    await browserExpect(viewports).toHaveCount(2);
    await browserExpect.poll(() => viewports.evaluateAll(nodes => nodes.every(
      node => node.scrollTop > 500))).toBe(true);
    const panels = [first.id, second.id].map(id => page.locator(
      `[data-conversation-panel-chat-id="${id}"] [data-chat-scroll-viewport]`));
    for (const panel of panels) await panel.evaluate(node => { node.scrollTop = 300; });
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Tile working chats' }).press('Enter');
    await page.waitForFunction(() => localStorage.getItem('workspace_layout_v2')?.includes('partition-tile-'));
    await browserExpect(page.getByRole('menu')).toHaveCount(0);
    expect(await Promise.all(panels.map(panel => panel.evaluate(node => node.scrollTop)))).toEqual([300, 300]);
    await browserExpect(composer).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(`/chat/${second.id}`);

    const divider = page.getByRole('separator', { name: 'Resize windows' });
    const handle = divider.locator('[data-workspace-window-resize-hit-area]');
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + 150, y, { steps: 3 });
      await browserExpect(divider).not.toHaveAttribute('aria-valuenow', '50');
      await page.getByRole('button', { name: 'More actions' }).press('Enter');
      await page.getByRole('menuitem', { name: 'Tile working chats' }).press('Enter');
      await browserExpect(divider).toHaveAttribute('aria-valuenow', '50');
    } finally {
      await page.mouse.up();
    }
    await browserExpect(divider).toHaveAttribute('aria-valuenow', '50');
  });
}, 60_000);

test('hiding the sidebar in fullscreen dismisses its portaled menu', async () => {
  await withChromiumFixture('tile-fullscreen-menu', async ({ page, integration }) => {
    const chatId = integration.newChatId();
    const content = 'Hold the fullscreen chat';
    const held = integration.fakeProviders.openAi.holdNext({ lastUserText: content });
    using holds = new DisposableStack();
    await integration.client.startDirectChat({
      chatId, content, projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
    });
    await held.received;
    holds.defer(() => held.releaseEcho());
    await page.setViewportSize({ width: 790, height: 400 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await page.getByRole('button', { name: 'More actions' }).click();
    const tile = page.getByRole('menuitem', { name: 'Tile working chats' });
    await tile.hover();
    await page.mouse.down();
    const sidebar = page.locator('[data-workspace-chat-list-panel]');
    await sidebar.evaluate(panel => {
      const observer = new MutationObserver(() => {
        if (!panel.hasAttribute('inert')) return;
        observer.disconnect();
        const menu = document.querySelector('[role="menu"]');
        panel.setAttribute('data-menu-was-inert', String(!menu || menu.closest('[inert]') !== null));
      });
      observer.observe(panel, { attributes: true, attributeFilter: ['inert'] });
    });
    await page.keyboard.press('Control+Shift+F');
    await page.mouse.up();
    await browserExpect(sidebar).toHaveAttribute('data-menu-was-inert', 'true');
    await browserExpect(page.getByRole('menu')).toHaveCount(0);
    await browserExpect(sidebar).toHaveAttribute('inert', '');
  });
});
