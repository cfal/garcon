import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { authenticateChromiumContext, withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred, withTimeout } from '../../support/deferred.js';

test('Shell composer preserves literal commands and stable chat switching on desktop and mobile', async () => {
  await withChromiumFixture('shell-composer', async ({ page, browser, integration, assertNoBrowserErrors }, phase) => {
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
    phase('unlabeled output has no header gap and keeps Copy accessible');
    const plainBlock = page.locator('.markdown-code-block').filter({ hasText: '**plain output**' });
    const copy = plainBlock.getByRole('button');
    const code = plainBlock.locator('code');
    const blockBounds = (await plainBlock.boundingBox())!;
    expect((await code.boundingBox())!.y - blockBounds.y).toBeLessThan(20);
    await page.mouse.move(0, 0);
    await browserExpect(copy).toHaveCSS('opacity', '0');
    await plainBlock.hover();
    await browserExpect(copy).toHaveCSS('opacity', '1');
    await browserExpect(copy).toHaveCSS('border-top-width', '1px');
    expect(await copy.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await page.mouse.move(0, 0);
    await copy.focus();
    await browserExpect(copy).toHaveCSS('opacity', '1');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.keyboard.press('Enter');
    await browserExpect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('**plain output**');
    const codeArtifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(codeArtifacts, { recursive: true });
    await plainBlock.screenshot({ path: join(codeArtifacts, 'shell-code-copy-desktop.png') });

    const touchContext = await browser.newContext({
      viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    });
    try {
      await authenticateChromiumContext(touchContext, integration);
      const touchPage = await touchContext.newPage();
      await touchPage.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`);
      const touchBlock = touchPage.locator('.markdown-code-block').filter({ hasText: '**plain output**' });
      const touchCopy = touchBlock.getByRole('button');
      await browserExpect(touchCopy).toHaveCSS('opacity', '1');
      const touchBounds = (await touchBlock.boundingBox())!;
      const textBounds = (await touchBlock.locator('code').boundingBox())!;
      expect(textBounds.y - touchBounds.y).toBeLessThan(20);
      expect(textBounds.x + textBounds.width).toBeLessThanOrEqual((await touchCopy.boundingBox())!.x);
      await touchCopy.tap();
      await browserExpect(touchCopy.locator('.lucide-check')).toBeVisible();
      await touchBlock.screenshot({ path: join(codeArtifacts, 'shell-code-copy-touch.png') });
    } finally {
      await touchContext.close();
    }
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

    phase('delayed follow-up does not resurrect the prior duplicate error');
    const followUpReceived = new Deferred<void>();
    const followUpRelease = new Deferred<void>();
    await page.route('**/api/v1/chats/run', async route => {
      followUpReceived.resolve();
      await followUpRelease.promise;
      await route.continue();
    });
    try {
      await editor.fill('printf follow-up-output');
      await editor.press('Enter');
      await withTimeout(followUpReceived.promise, 5000, () => 'Expected held follow-up');
      await browserExpect(page.locator('pre').filter({ hasText: 'printf follow-up-output' })).toBeVisible();
      await browserExpect(page.getByText('Exit 127', { exact: true })).toHaveCount(2);
    } finally {
      followUpRelease.resolve();
    }
    await browserExpect(page.locator('.markdown-code-block pre').filter({ hasText: 'follow-up-output' })).toBeVisible();
    await page.unroute('**/api/v1/chats/run');
    await client.waitForProcessing(chatIds[0]!, false);

    phase('native Reload preserves failures without completion rows');
    await client.reloadChat(chatIds[0]!);
    await page.reload();
    await browserExpect(editor).toBeVisible();
    await browserExpect(page.getByText('Exit 127', { exact: true })).toHaveCount(2);
    await browserExpect(page.getByText('Completed', { exact: true })).toHaveCount(0);

    phase('frozen history preserves the same status presentation');
    const forkId = integration.newChatId();
    await client.forkChat({ sourceChatId: chatIds[0]!, chatId: forkId, allowHandoffFork: true });
    await page.goto(`${integration.garcon.baseUrl}/chat/${forkId}`);
    await browserExpect(page.getByText('Exit 127', { exact: true })).toHaveCount(2);
    await browserExpect(page.getByText('Completed', { exact: true })).toHaveCount(0);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`);
    await browserExpect(editor).toBeVisible();
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
    phase('cwd settlement failure stays visible once across browser refresh');
    await editor.fill('cd "$HOME"');
    await composer.getByRole('button', { name: 'Send message', exact: true }).click();
    await browserExpect(page.getByText('Working directory not saved', { exact: true })).toBeVisible();
    await client.waitForProcessing(chatIds[0]!, false);
    await browserExpect(page.getByText('Command completed, but its working directory is unavailable (outside-base).', { exact: true }))
      .toHaveCount(1);
    await page.reload();
    await browserExpect(page.getByText('Working directory not saved', { exact: true })).toBeVisible();
    await browserExpect(page.getByText('Command completed, but its working directory is unavailable (outside-base).', { exact: true }))
      .toHaveCount(1);
    expect(integration.fakeProviders.openAi.requests()).toHaveLength(0);
    expect(integration.fakeProviders.anthropic.requests()).toHaveLength(0);
    assertNoBrowserErrors();
  });
}, 150_000);
