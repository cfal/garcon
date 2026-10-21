import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('Shell and Notes app commands use the controller without submitting their wrappers', async () => {
  await withChromiumFixture('shell-slash-commands', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client } = integration;
    for (const model of ['sh', 'notes-markdown']) {
      const chatId = integration.newChatId();
      const started = await client.startChat({ chatId, agentId: 'shell', model,
        projectPath: integration.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'true' });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      const mobile = model === 'notes-markdown';
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const editor = page.locator('[data-composer] textarea');
      const send = page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true });
      await browserExpect(editor).toBeVisible();
      phase(`${model}: completion and metadata commands`);
      await editor.fill('/ren');
      await browserExpect(page.getByRole('listbox')).toBeVisible();
      await editor.press('Tab');
      await browserExpect(editor).toHaveValue('/rename ');
      await editor.fill(`/rename Synthetic ${model}`);
      if (mobile) await send.click();
      else await editor.press('Enter');
      await browserExpect(editor).toHaveValue('');
      await browserExpect.poll(async () => (await client.listChats()).sessions.find(chat => chat.id === chatId)?.title).toBe(`Synthetic ${model}`);
      await editor.fill('/tag add synthetic');
      await send.click();
      await browserExpect(editor).toHaveValue('');
      await browserExpect.poll(async () => (await client.listChats()).sessions.find(chat => chat.id === chatId)?.tags).toContain('synthetic');

      const source = ' /md printf "scheduled"  \n';
      await editor.fill(`/in 1h ${source}`);
      await send.click();
      await browserExpect(editor).toHaveValue('');
      await browserExpect.poll(async () => (await client.getScheduledPrompts()).prompts).toContainEqual(browserExpect.objectContaining({
        prompt: source, target: browserExpect.objectContaining({ chatId, busyBehavior: 'skip',
          expectedSelection: browserExpect.objectContaining({ agentId: 'shell', model }) }),
      }));
      expect((await client.getMessages(chatId)).messages.filter(row => row.message.type === 'user-message')).toHaveLength(1);

      if (model === 'sh') {
        phase('Shell: Ctrl+Enter dispatches metadata while a command runs');
        const holding = await client.runChat({ chatId,
          command: 'while [ ! -f slash-release ]; do sleep 0.05; done',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await client.waitForProcessing(chatId, true);
        await editor.fill('/rename Synthetic busy shell');
        await editor.press('Control+Enter');
        await browserExpect(editor).toHaveValue('');
        await browserExpect.poll(async () => (await client.listChats()).sessions.find(chat => chat.id === chatId)?.title).toBe('Synthetic busy shell');
        await writeFile(join(integration.executionDirs.project, 'slash-release'), 'released');
        await client.waitForTurnTerminal(chatId, holding.turnId);
        await client.waitForProcessing(chatId, false);
      } else {
        phase('Notes: unrecognized forms stay literal and bare fork copies without execution');
        for (const source of ['/md inert', ' /rename not-a-title', '/fork with a body']) {
          await editor.fill(source);
          await browserExpect(page.getByRole('listbox')).toHaveCount(0);
          const afterIndex = client.markEvents();
          await send.click();
          await client.waitForTurnTerminal(chatId, undefined, { afterIndex });
          await client.waitForProcessing(chatId, false);
          await browserExpect(editor).toHaveValue('');
        }
        const beforeFork = (await client.listChats()).sessions.length;
        const sourceInputs = (await client.getMessages(chatId)).messages
          .filter(row => row.message.type === 'user-message').map(row => row.message);
        await editor.fill('/fork ');
        await send.click();
        await browserExpect(page).not.toHaveURL(new RegExp(`/chat/${chatId}$`));
        expect((await client.listChats()).sessions).toHaveLength(beforeFork + 1);
        await browserExpect(page.locator('[data-chat-feed-content]')).toContainText('/fork with a body');
        const forkId = new URL(page.url()).pathname.split('/').at(-1)!;
        for (const id of [chatId, forkId]) {
          const inputs = (await client.getMessages(id)).messages
            .filter(row => row.message.type === 'user-message').map(row => row.message);
          expect(inputs).toEqual(sourceInputs);
        }
        expect((await client.getChatSnapshot(forkId)).chat.canReloadFromNativeHistory).toBe(false);
      }
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, `shell-slash-${mobile ? 'mobile' : 'desktop'}.png`) });
    }
    assertNoBrowserErrors();
  });
}, 180_000);
