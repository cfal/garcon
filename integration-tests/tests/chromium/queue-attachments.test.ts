import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('queues a composer image behind a running turn and sends it with its own turn', async () => {
  await withChromiumFixture('queue-attachments', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents, fakeProviders } = integration;
    const chatId = integration.newChatId();
    const held = fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic running turn' });
    await client.startDirectChat({
      chatId,
      content: 'Synthetic running turn',
      projectPath: integration.dirs.project,
      agent: directAgents.anthropic,
    });
    await held.received;

    phase('attaching an image while the composer queues');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const composer = page.getByPlaceholder('Reply...', { exact: true });
    const queueButton = page.getByRole('button', { name: 'Queue message', exact: true });
    // A remote executor validates the model catalog after the first paint.
    await browserExpect(queueButton).toBeVisible({ timeout: 20_000 });
    await composer.fill('Synthetic queued caption');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'queued.png',
      mimeType: 'image/png',
      buffer: IMAGE,
    });
    const draftAttachment = page.getByRole('button', {
      name: 'Remove attachment queued.png',
      exact: true,
    });
    await browserExpect(draftAttachment).toBeVisible();
    await browserExpect(queueButton).toBeEnabled();

    phase('queueing the image from the keyboard');
    const queueRequest = page.waitForRequest((request) => (
      new URL(request.url()).pathname === '/api/v1/chats/queue/entries'
      && request.method() === 'POST'
    ));
    await composer.press('Enter');
    expect((await queueRequest).postDataJSON()).toMatchObject({
      chatId,
      content: 'Synthetic queued caption',
      images: [{
        name: 'queued.png',
        mimeType: 'image/png',
        data: `data:image/png;base64,${IMAGE.toString('base64')}`,
      }],
    });
    const dock = page.locator('[data-queue-status-summary]');
    await browserExpect(dock.locator('[data-queue-preview]')).toHaveText('Synthetic queued caption');
    await browserExpect(dock.locator('[data-queue-preview-attachments]'))
      .toHaveAttribute('title', 'queued.png');
    await browserExpect(draftAttachment).toHaveCount(0);
    await browserExpect(composer).toHaveValue('');

    phase('dispatching the queued image after the running turn');
    held.releaseEcho();
    const received = await fakeProviders.anthropic.waitForRequest({
      lastUserText: 'Synthetic queued caption',
    });
    expect(received.body.messages.findLast((entry) => entry.role === 'user')?.content)
      .toEqual(expect.arrayContaining([{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: IMAGE.toString('base64') },
      }]));
    await browserExpect(dock).toHaveCount(0);
    await browserExpect(page.getByRole('img', { name: 'queued.png', exact: true })).toBeVisible();
    assertNoBrowserErrors();
  });
}, 120_000);
