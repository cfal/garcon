import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const IMAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.each(['idle', 'queued'] as const)('drops native files onto the %s composer and sends them', async (mode) => {
  await withChromiumFixture(`composer-file-drop-${mode}`, async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents, fakeProviders } = integration;
    const chatId = integration.newChatId();
    const held = mode === 'queued'
      ? fakeProviders.anthropic.holdNext({ lastUserText: 'Synthetic running turn' })
      : null;
    const started = await client.startDirectChat({
      chatId,
      content: 'Synthetic running turn',
      projectPath: integration.dirs.project,
      agent: directAgents.anthropic,
    });
    if (held) await held.received;
    else {
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
    }

    phase('dragging files with native Chromium hit testing');
    const files = [
      join(integration.dirs.project, 'dropped.png'),
      join(integration.dirs.project, 'notes.md'),
      join(integration.dirs.project, 'unsupported.zip'),
    ];
    await Promise.all([
      writeFile(files[0]!, IMAGE),
      writeFile(files[1]!, 'Synthetic attachment notes'),
      writeFile(files[2]!, 'Synthetic unsupported archive'),
    ]);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const textarea = page.getByPlaceholder('Reply...', { exact: true });
    const caption = `Synthetic ${mode} dropped attachments`;
    await textarea.fill(caption);
    const composer = page.locator('[data-composer]');
    const send = page.getByRole('button', {
      name: mode === 'queued' ? 'Queue message' : 'Send message', exact: true,
    });
    await browserExpect(send).toBeVisible({ timeout: 20_000 });
    await browserExpect(send).toBeEnabled();
    const target = page.getByRole('button', { name: 'Add to prompt', exact: true });
    const bounds = await target.boundingBox();
    if (!bounds) throw new Error('Missing composer drop target bounds');
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const inputBounds = await textarea.boundingBox();
    if (!inputBounds) throw new Error('Missing composer input bounds');
    const inputPoint = { x: inputBounds.x + 20, y: inputBounds.y + 20 };
    const session = await context.newCDPSession(page);
    const data = { items: [], files, dragOperationsMask: 1 };
    try {
      await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...inputPoint, data });
      await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...inputPoint, data });
      await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...point, data });
      const overlay = composer.locator('[data-attachment-drop-overlay]');
      await browserExpect(overlay).toBeVisible();
      expect(await overlay.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
      const screenshotDir = process.env.ATTACHMENT_DROP_SCREENSHOT_DIR;
      if (screenshotDir && mode === 'idle') {
        await mkdir(screenshotDir, { recursive: true });
        await composer.screenshot({ path: join(screenshotDir, 'desktop-drop.png') });
      }
      await session.send('Input.dispatchDragEvent', { type: 'drop', ...point, data });
      await browserExpect(overlay).toHaveCount(0);
    } finally {
      await session.detach();
    }
    const image = page.getByRole('button', { name: 'Remove attachment dropped.png', exact: true });
    const notes = page.getByRole('button', { name: 'Remove attachment notes.md', exact: true });
    await browserExpect(image).toBeVisible();
    await browserExpect(notes).toBeVisible();
    await browserExpect(page.getByRole('button', { name: 'Remove attachment unsupported.zip' })).toHaveCount(0);
    await browserExpect(textarea).toHaveValue(caption);

    if (mode === 'idle') {
      phase('checking the mobile composer with dropped attachments');
      await page.setViewportSize({ width: 390, height: 844 });
      await browserExpect(notes).toBeVisible();
      const screenshotDir = process.env.ATTACHMENT_DROP_SCREENSHOT_DIR;
      if (screenshotDir) await composer.screenshot({ path: join(screenshotDir, 'mobile-attachments.png') });
    }

    phase('submitting dropped attachments');
    const afterId = fakeProviders.anthropic.requests().at(-1)?.id ?? 0;
    if (mode === 'idle') await send.click();
    else await textarea.press('Enter');
    await browserExpect(image).toHaveCount(0);
    await browserExpect(notes).toHaveCount(0);
    if (held) {
      await browserExpect(page.locator('[data-queue-preview-attachments]')).toHaveAttribute('title', 'dropped.png, notes.md');
      held.releaseEcho();
    }
    const received = await fakeProviders.anthropic.waitForRequest({}, { afterId });
    expect(received.lastUserText).toContain(caption);
    const content = received.body.messages.findLast((entry) => entry.role === 'user')?.content;
    expect(content).toEqual(expect.arrayContaining([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: IMAGE.toString('base64') },
    }]));
    expect(JSON.stringify(content)).toContain('Synthetic attachment notes');
    assertNoBrowserErrors();
  });
}, 120_000);
