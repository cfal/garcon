import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('Shell composer preserves literal commands and stable chat switching on desktop and mobile', async () => {
  await withChromiumFixture('shell-composer', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, executionDirs } = integration;
    const chatIds: string[] = [];
    for (const text of ['**plain output**', 'second chat']) {
      const chatId = integration.newChatId();
      const started = await client.startChat({ chatId, agentId: 'shell', model: 'sh',
        projectPath: executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: `printf '${text}'`,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      chatIds.push(chatId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`);
    const composer = page.locator('[data-composer]');
    const editor = composer.locator('textarea');
    await browserExpect(editor).toBeVisible();
    await browserExpect(page.locator('.markdown-code-block pre').filter({ hasText: '**plain output**' })).toBeVisible();
    await browserExpect(composer.getByRole('button', { name: 'Refine prompt', exact: true })).toBeVisible();
    await editor.evaluate(element => element.setAttribute('data-retained-shell-editor', 'true'));

    phase('literal absolute path through Enter submission');
    const source = '  /bin/printf "<garcon-get-chat-id />\\n"\n ';
    await editor.fill(source);
    await editor.press('Enter');
    await browserExpect(page.locator('pre').filter({ hasText: '<garcon-get-chat-id />' }).last()).toBeVisible();
    await browserExpect(editor).toHaveValue('');
    await browserExpect.poll(async () => (await client.getMessages(chatIds[0]!)).messages
      .flatMap(row => row.message.type === 'user-message' ? [row.message.content] : [])).toContain(source);

    phase('executor-owned Markdown prefix through button submission');
    await editor.fill('/markdown printf "# Command heading\\n"; printf "**literal diagnostic**" >&2');
    await composer.getByRole('button', { name: 'Send message', exact: true }).click();
    await browserExpect(page.getByRole('heading', { name: 'Command heading', exact: true })).toBeVisible();
    await browserExpect(page.locator('.markdown-code-block pre').filter({ hasText: '**literal diagnostic**' })).toBeVisible();
    await editor.fill('retained draft');
    const top = (await composer.boundingBox())!.y;
    for (const id of [chatIds[1]!, chatIds[0]!, chatIds[1]!, chatIds[0]!]) {
      await page.locator(`[data-sidebar-virtual-row="${id}"]`).click();
      await browserExpect(page.locator('[data-conversation-panel-composer-anchor="true"]'))
        .toHaveAttribute('data-conversation-panel-chat-id', id);
      await browserExpect(editor).toHaveAttribute('data-retained-shell-editor', 'true');
      await browserExpect(editor).toHaveValue(id === chatIds[0] ? 'retained draft' : '');
      expect(Math.abs((await composer.boundingBox())!.y - top)).toBeLessThan(2);
    }

    phase('responsive rendering and focus retention');
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await editor.focus();
      await browserExpect(editor).toBeFocused();
      await browserExpect(editor).toHaveValue('retained draft');
      const bounds = (await composer.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: join(artifacts, `shell-composer-${width}.png`) });
    }
    expect(integration.fakeProviders.openAi.requests()).toHaveLength(0);
    expect(integration.fakeProviders.anthropic.requests()).toHaveLength(0);
    assertNoBrowserErrors();
  });
}, 150_000);
