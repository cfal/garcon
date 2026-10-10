import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred, withTimeout } from '../../support/deferred.js';

test('Shell composer preserves literal commands and stable chat switching on desktop and mobile', async () => {
  await withChromiumFixture('shell-composer', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, executionDirs } = integration;
    const chatIds: string[] = [];
    for (const text of ['**plain output**', 'second chat']) {
      const chatId = integration.newChatId();
      const started = await client.startChat({ chatId, agentId: 'shell', model: 'bash',
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
    await browserExpect(page.getByText('Completed', { exact: true })).toHaveCount(0);
    await browserExpect(page.getByText('text', { exact: true })).toHaveCount(0);
    await browserExpect(page.getByText(/cannot set terminal process group|no job control in this shell/)).toHaveCount(0);
    await browserExpect(composer.getByRole('button', { name: 'Refine prompt', exact: true })).toBeVisible();
    await editor.evaluate(element => element.setAttribute('data-retained-shell-editor', 'true'));

    phase('optimistic input stays literal before command delivery');
    const received = new Deferred<void>();
    const release = new Deferred<void>();
    await page.route('**/api/v1/chats/run', async route => {
      received.resolve();
      await release.promise;
      await route.continue();
    });
    const pendingSource = '# Pending literal heading\n  printf "pending output"\n';
    try {
      await editor.fill(pendingSource);
      await editor.press('Enter');
      await withTimeout(received.promise, 5000, () => 'Expected held Shell submission');
      const pending = page.locator('pre').filter({ hasText: '# Pending literal heading' });
      await browserExpect(pending).toHaveText(pendingSource);
      await browserExpect(page.getByRole('heading', { name: 'Pending literal heading', exact: true })).toHaveCount(0);
    } finally {
      release.resolve();
    }
    await browserExpect(page.locator('.markdown-code-block pre').filter({ hasText: 'pending output' })).toBeVisible();
    await page.unroute('**/api/v1/chats/run');

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

    phase('one durable error per failed command, including after browser reload');
    for (let count = 1; count <= 2; count++) {
      await editor.fill('garcon_nonexistent_command');
      await editor.press('Enter');
      await browserExpect(page.getByText('Exit 127', { exact: true })).toHaveCount(count);
      await client.waitForProcessing(chatIds[0]!, false);
      await browserExpect(page.getByText('Exit 127', { exact: true })).toHaveCount(count);
    }
    await page.reload();
    await browserExpect(editor).toBeVisible();
    await browserExpect(page.getByText('Exit 127', { exact: true })).toHaveCount(2);
    await browserExpect(page.getByText('Completed', { exact: true })).toHaveCount(0);
    await editor.evaluate(element => element.setAttribute('data-retained-shell-editor', 'true'));
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
