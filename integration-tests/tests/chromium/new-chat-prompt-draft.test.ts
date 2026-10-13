import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('new chat restores an unsent prompt after closing and after reload', async () => {
  await withChromiumFixture('new-chat-prompt-draft', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    const newChat = page.getByRole('button', { name: 'New Chat', exact: true }).first();
    const prompt = page.getByPlaceholder('How can I help you today?');

    await newChat.click();
    await browserExpect(prompt).toBeFocused();
    await prompt.fill('Unsent prompt');
    await prompt.press('Escape');
    await browserExpect(prompt).toHaveCount(0);

    await newChat.click();
    await browserExpect(prompt).toHaveValue('Unsent prompt');
    await prompt.fill('Unsent prompt, continued');
    await prompt.press('Escape');
    await browserExpect(prompt).toHaveCount(0);

    await page.reload();
    await newChat.click();
    await browserExpect(prompt).toHaveValue('Unsent prompt, continued');

    await prompt.fill('');
    await prompt.press('Escape');
    await browserExpect(prompt).toHaveCount(0);
    await page.reload();
    await newChat.click();
    await browserExpect(prompt).toBeFocused();
    await browserExpect(prompt).toHaveValue('');

    await page.evaluate(() => {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'chat_draft_new-chat') throw new DOMException('Storage full', 'QuotaExceededError');
        return originalSetItem.call(this, key, value);
      };
    });
    await prompt.fill('Unsent prompt while storage is unavailable');
    await prompt.press('Escape');
    await browserExpect(prompt).toHaveCount(0);
    await newChat.click();
    await browserExpect(prompt).toHaveValue('Unsent prompt while storage is unavailable');

    expect((await integration.client.listChats()).sessions).toEqual([]);
    assertNoBrowserErrors();
  });
}, 120_000);
