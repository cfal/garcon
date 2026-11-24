import { expect, test } from 'bun:test';
import { expect as browserExpect, type Page } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction } from '../../support/chromium-workspace.js';
import { runCli } from '../../support/cli-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

test('fork parent picker and CLI converge without changing lineage or reloading conversations', async () => {
  await withChromiumFixture('chat-parent', async ({ page, context, integration, assertNoBrowserErrors, withExpectedConsoleErrors }, phase) => {
    await context.addInitScript(seedLocalSettings, { collapseDelegatedChatsByDefault: false });
    const child = integration.newChatId();
    const source = integration.newChatId();
    const parent = integration.newChatId();
    const other = integration.newChatId();
    const chats = [[source, 'Source task'], [parent, 'Parent task'], [other, 'Another parent']] as const;
    for (const [chatId, title] of chats) {
      const started = await integration.client.startDirectChat({ chatId, content: 'Synthetic parent picker task.',
        projectPath: integration.executionDirs.project, agent: integration.directAgents.openAi });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await integration.client.updateSessionName(chatId, title);
    }
    const forked = await integration.client.forkChat({ sourceChatId: source, chatId: child });
    await integration.client.updateSessionName(child, 'Child task');
    await page.goto(`${integration.garcon.baseUrl}/chat/${child}`);
    const second = await context.newPage();
    await second.goto(`${integration.garcon.baseUrl}/chat/${parent}`);
    await clickWorkspaceWindowAddAction(second, 'Open Chat Map');
    const sidebarParent = (tab: Page) => tab.locator('[data-sidebar-virtual-row]').evaluateAll((rows, id) => {
      const index = rows.findIndex((row) => row.getAttribute('data-sidebar-virtual-row') === id);
      return rows[index - 1]?.getAttribute('data-sidebar-virtual-row') ?? null;
    }, child);
    const secondChildRow = second.locator(`[data-sidebar-virtual-row="${child}"]`);
    const childRow = page.locator(`[data-sidebar-virtual-row="${child}"]`);
    await browserExpect(childRow).toHaveAttribute('data-sidebar-row-depth', '0');
    const menuTrigger = page.locator('[data-workspace-window-current="true"] [data-workspace-window-menu-trigger]');

    async function verifyContextMenuClosesOnHistoryNavigation() {
      await page.locator(`[data-sidebar-virtual-row="${parent}"] button`).first().click();
      await childRow.locator('button').first().click();
      await page.getByRole('tab', { name: 'Child task', exact: true }).click({ button: 'right' });
      await browserExpect(page.getByRole('menuitem', { name: 'Set parent chat ID', exact: true })).toBeVisible();
      await page.goBack();
      await browserExpect(page).toHaveURL(`${integration.garcon.baseUrl}/chat/${parent}`);
      await browserExpect(page.getByRole('menu')).toHaveCount(0);
      await childRow.locator('button').first().click();
    }

    phase('single-tab context menu closes when history replaces the chat');
    await verifyContextMenuClosesOnHistoryNavigation();

    phase('switching tabs closes the menu instead of retargeting its actions');
    await clickWorkspaceWindowAddAction(page, 'Open Chat Map');
    await page.getByRole('tab', { name: 'Child task', exact: true }).click();
    await verifyContextMenuClosesOnHistoryNavigation();
    await menuTrigger.click();
    await browserExpect(page.getByRole('menuitem', { name: 'Set parent chat ID', exact: true })).toBeVisible();
    await page.keyboard.press('Control+Shift+L');
    await browserExpect(page.locator('[data-workspace-window-current="true"]')).toHaveAttribute(
      'data-workspace-window-active-surface', 'singleton:chat-map');
    await browserExpect(page.getByRole('menu')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Child task', exact: true }).click();

    const composer = page.locator('[data-composer]:visible');
    await browserExpect(composer).toBeVisible();
    await composer.evaluate((element) => { element.dataset.parentTestIdentity = 'retained'; });
    const viewport = page.locator('[data-chat-scroll-viewport]:visible');
    const scrollBefore = await viewport.evaluate((element) => element.scrollTop);
    const boxBefore = await composer.boundingBox();

    phase('editing via the desktop feed menu');
    await menuTrigger.click();
    await page.getByRole('menuitem', { name: 'Set parent chat ID', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Set parent chat ID', exact: true });
    const input = dialog.getByRole('combobox', { name: 'Parent chat', exact: true });
    await input.fill('Parent task');
    await browserExpect(dialog.getByRole('option')).toHaveCount(1);
    await input.press('ArrowDown');
    await input.press('Enter');
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'chat-parent-desktop.png') });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect(childRow).toHaveAttribute('data-sidebar-row-depth', '1');
    await browserExpect(secondChildRow).toHaveAttribute('data-sidebar-row-depth', '1');
    for (const tab of [page, second]) await browserExpect.poll(() => sidebarParent(tab)).toBe(parent);
    const mapParent = () => second.locator(`[data-chat-map-chat-id="${child}"]`).evaluate((element) =>
      element.closest('[data-chat-map-node]')?.parentElement?.closest<HTMLElement>('[data-chat-map-node]')?.dataset.chatMapNode ?? null);
    await browserExpect.poll(mapParent).toBe(`chat:${source}`);
    await browserExpect(composer).toHaveAttribute('data-parent-test-identity', 'retained');
    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
    expect(await composer.boundingBox()).toEqual(boxBefore);

    phase('replacing through the CLI while both tabs remain open');
    const replaced = await runCli(integration, ['set-parent', child, other, '--json'], 'controller');
    expect(replaced, replaced.stderr).toMatchObject({ exitCode: 0 });
    for (const tab of [page, second]) await browserExpect.poll(() => sidebarParent(tab)).toBe(other);
    await browserExpect.poll(mapParent).toBe(`chat:${source}`);
    await browserExpect(childRow).toHaveAttribute('data-sidebar-row-depth', '1');
    expect(page.url()).toContain(`/chat/${child}`);

    phase('failed keyboard saves retain focus and cannot be dismissed while pending');
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    await page.route('**/api/v1/chats/parent', async (route) => {
      entered.resolve();
      await reply.promise;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({
        success: false, error: 'Synthetic parent rejection', errorCode: 'CHAT_PARENT_CYCLE',
      }) });
    });
    try {
      await menuTrigger.click();
      await page.getByRole('menuitem', { name: 'Set parent chat ID', exact: true }).click();
      await input.fill(parent);
      await input.press('Enter');
      await entered.promise;
      await browserExpect(input).toBeFocused();
      await browserExpect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
      await input.press('Escape');
      await input.press('Escape');
      await browserExpect(dialog).toBeVisible();
      await withExpectedConsoleErrors(['Failed to load resource: the server responded with a status of 409 (Conflict)'], async () => {
        reply.resolve();
        await browserExpect(dialog.getByRole('alert')).toContainText('Synthetic parent rejection');
      });
      await browserExpect(input).toBeFocused();
      await browserExpect(input).toHaveValue(parent);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
      reply.resolve();
      await page.unroute('**/api/v1/chats/parent');
    }

    phase('mobile picker, Escape handling, explicit clear and geometry');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-mobile-current-chat-menu] button').click();
    await page.getByRole('menuitem', { name: 'Set parent chat ID', exact: true }).click();
    await input.fill('Parent');
    await input.press('ArrowDown');
    await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true });
    await browserExpect(input).toHaveValue('Parent');
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
    await browserExpect(dialog.getByRole('listbox')).toBeVisible();
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: false, keyCode: 229, bubbles: true });
    await browserExpect(dialog.getByRole('listbox')).toBeVisible();
    await input.press('Escape');
    await browserExpect(dialog).toBeVisible();
    await browserExpect(dialog.getByRole('listbox')).toHaveCount(0);
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: false, keyCode: 229, bubbles: true });
    await browserExpect(dialog).toBeVisible();
    await browserExpect(input).toHaveValue('Parent');
    expect(await input.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(artifacts, 'chat-parent-mobile.png') });
    await dialog.getByRole('button', { name: 'Remove parent', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect.poll(mapParent).toBe(`chat:${source}`);
    expect((await integration.client.listChats()).sessions.find((chat) => chat.id === child)?.lineage)
      .toEqual(forked.chat.lineage);
    await page.setViewportSize({ width: 1440, height: 900 });
    await browserExpect(childRow).toHaveAttribute('data-sidebar-row-depth', '0');
    await browserExpect(secondChildRow).toHaveAttribute('data-sidebar-row-depth', '0');
    await browserExpect(composer).toHaveAttribute('data-parent-test-identity', 'retained');
    assertNoBrowserErrors();
  });
});
