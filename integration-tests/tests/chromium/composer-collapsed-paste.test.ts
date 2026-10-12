import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const TABLE = [
  '| Check | Result |',
  '| --- | --- |',
  ...Array.from({ length: 40 }, (_, index) => `| Synthetic check ${index} | Synthetic result ${index} |`),
].join('\n');
const LABEL = `[Pasted Content ${TABLE.length} chars]`;

test('a large paste collapses into an atomic label and is sent in full', async () => {
  await withChromiumFixture('composer-collapsed-paste', async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents, fakeProviders } = integration;
    const chatIds = [integration.newChatId(), integration.newChatId()];
    for (const [index, chatId] of chatIds.entries()) {
      const turn = await client.startDirectChat({
        chatId,
        content: `Synthetic collapsed paste conversation ${index}`,
        projectPath: integration.dirs.project,
        agent: directAgents.anthropic,
      });
      await client.waitForTurnTerminal(chatId, turn.turnId);
      await client.waitForProcessing(chatId, false);
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatIds[0]}`);
    const textarea = page.getByPlaceholder('Reply...', { exact: true });
    await textarea.waitFor();
    const paste = async (text: string) => {
      await page.evaluate((value) => navigator.clipboard.writeText(value), text);
      await page.keyboard.press('Control+V');
    };
    const screenshotDir = process.env.COLLAPSED_PASTE_SCREENSHOT_DIR;
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });

    phase('pasting below and above the collapse threshold');
    await textarea.fill('Review:\n');
    await paste('| a | b |');
    await browserExpect(textarea).toHaveValue('Review:\n| a | b |');
    await textarea.fill('Review:\n');
    await paste(TABLE.replaceAll('\n', '\r\n'));
    await browserExpect(textarea).toHaveValue(`Review:\n${LABEL}`);
    await page.keyboard.type(' please');
    await browserExpect(textarea).toHaveValue(`Review:\n${LABEL} please`);
    if (screenshotDir) {
      await page.locator('[data-composer]').screenshot({ path: join(screenshotDir, 'desktop-collapsed.png') });
    }

    phase('deleting the label as one unit and pasting again');
    for (let index = 0; index < ' please'.length + 1; index += 1) await page.keyboard.press('Backspace');
    await browserExpect(textarea).toHaveValue('Review:\n');
    await page.keyboard.type('x');
    await browserExpect(textarea).toHaveValue('Review:\nx');
    await page.keyboard.press('Backspace');
    await paste(TABLE);
    await browserExpect(textarea).toHaveValue(`Review:\n${LABEL}`);

    phase('keeping the label across a chat switch and the full draft across a reload');
    const chatList = page.getByRole('region', { name: 'Chat list' });
    await chatList.getByRole('button', { name: /Synthetic collapsed paste conversation 1/ }).click();
    await browserExpect(textarea).toHaveValue('');
    await chatList.getByRole('button', { name: /Synthetic collapsed paste conversation 0/ }).click();
    await browserExpect(textarea).toHaveValue(`Review:\n${LABEL}`);
    await page.reload();
    await browserExpect(textarea).toHaveValue(`Review:\n${TABLE}`);
    await textarea.fill('Review:\n');
    await paste(TABLE);
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(textarea).toHaveValue(`Review:\n${LABEL}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (screenshotDir) {
      await page.locator('[data-composer]').screenshot({ path: join(screenshotDir, 'mobile-collapsed.png') });
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    phase('sending the full pasted text');
    const afterId = fakeProviders.anthropic.requests().at(-1)?.id ?? 0;
    await textarea.press('Enter');
    const received = await fakeProviders.anthropic.waitForRequest({}, { afterId });
    expect(received.lastUserText).toBe(`Review:\n${TABLE}`);
    await browserExpect(textarea).toHaveValue('');
    const sentTable = page.locator('table').filter({ hasText: 'Synthetic check 39' });
    await browserExpect(sentTable.first()).toBeVisible();
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'desktop-sent.png') });
    assertNoBrowserErrors();
  });
}, 180_000);
