import { expect, test } from 'bun:test';
import { expect as browserExpect, type Locator, type Page } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

async function createImageBuffer(page: Page, dimensions: { width: number; height: number }): Promise<Buffer> {
  const encoded = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#238636';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(width / 4, height / 4, width / 2, height / 2);
    return canvas.toDataURL('image/png').split(',')[1];
  }, dimensions);
  return Buffer.from(encoded, 'base64');
}

async function expectDecodedImage(image: Locator): Promise<void> {
  await browserExpect.poll(() => image.evaluate((element) =>
    element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
  )).toBe(true);
}

async function expectSizeOptionsToFit(sizeSelect: Locator): Promise<void> {
  const optionWidths = await sizeSelect.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement)) throw new Error('Expected select');
    const styles = getComputedStyle(element);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = styles.font;
    const availableWidth = element.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
    return Array.from(element.options, (option) => ({
      text: option.text,
      width: context.measureText(option.text).width,
      availableWidth,
    }));
  });
  for (const option of optionWidths) {
    expect(option.width, option.text).toBeLessThanOrEqual(option.availableWidth);
  }
}

test('persists inline image size limits and bounds local and external images without distortion', async () => {
  await withChromiumFixture('markdown-image-layout', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, directAgents } = integration;
    const images = [
      { name: 'Wide capture', file: 'wide.png', width: 3200, height: 400 },
      { name: 'Tall capture', file: 'tall.png', width: 800, height: 2400 },
      { name: 'Small capture', file: 'small.png', width: 160, height: 90 },
    ];
    const buffers: Buffer[] = [];
    for (const dimensions of images) {
      const buffer = await createImageBuffer(page, dimensions);
      buffers.push(buffer);
      await writeFile(join(executionDirs.project, dimensions.file), buffer);
    }
    const externalUrl = 'https://images.example.test/capture.png';
    let externalAuthenticated = false;
    await page.route(externalUrl, async (route) => {
      externalAuthenticated ||= route.request().headers().authorization !== undefined;
      await route.fulfill({ contentType: 'image/png', body: buffers[0] });
    });
    const source = [
      ...images.map(({ name, file }) => `![${name}](${file})`),
      `![External capture](${externalUrl})`,
    ].join('\n\n');
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId,
      content: source,
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const otherChatId = integration.newChatId();
    const otherStarted = await client.startDirectChat({
      chatId: otherChatId,
      content: '![Other capture](small.png)',
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(otherChatId, otherStarted.turnId);
    const releaseSettings = new Deferred<void>();
    let settingsRequested = false;
    await page.route('**/api/v1/app/settings', async (route) => {
      settingsRequested = true;
      await releaseSettings.promise;
      await route.continue();
    });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const assistant = page.locator('[data-chat-message-type="assistant-message"]');
    const smallImage = assistant.getByRole('img', { name: 'Small capture', exact: true });
    try {
      await expectDecodedImage(smallImage);
      expect(settingsRequested).toBe(true);
    } finally {
      releaseSettings.resolve();
    }
    const artifactDirectory = new URL('../../artifacts/chromium/', import.meta.url).pathname;
    await mkdir(artifactDirectory, { recursive: true });
    await browserExpect(page.locator('html')).toHaveAttribute('data-inline-image-thumbnail-size', 'medium');
    const thumbnailSizes = [
      { size: 'medium', maxWidth: 640, maxHeight: 320 },
      { size: 'small', maxWidth: 320, maxHeight: 180 },
      { size: 'large', maxWidth: 960, maxHeight: 480 },
    ];
    const viewports = [
      { label: 'desktop', width: 1440, height: 900 },
      { label: 'mobile', width: 390, height: 844 },
    ];
    const renderedImages = [...images, { name: 'External capture', width: 3200, height: 400 }];
    for (const { size, maxWidth, maxHeight } of thumbnailSizes) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await browserExpect(page.locator('.mobile-shell')).toHaveCount(0);
      if (size !== 'medium') {
        await assistant.locator('.markdown-image').nth(2).scrollIntoViewIfNeeded();
        await browserExpect(smallImage).toHaveAttribute('src', /^blob:/);
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
        const sizeSelect = dialog.getByRole('combobox', { name: 'Inline image thumbnail size (px)' });
        // Isolates preference changes from desktop/mobile presentation remounts.
        const originalImage = await smallImage.elementHandle();
        const originalSource = await smallImage.getAttribute('src');
        await sizeSelect.selectOption(size);
        await browserExpect(page.locator('html')).toHaveAttribute('data-inline-image-thumbnail-size', size);
        await browserExpect(smallImage).toHaveAttribute('src', originalSource!);
        expect(await smallImage.evaluate((element, original) => element === original, originalImage)).toBe(true);
        await originalImage?.dispose();
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await browserExpect(page.locator('.mobile-shell')).toHaveCount(1);
          await sizeSelect.scrollIntoViewIfNeeded();
          expect(await dialog.getByRole('tabpanel').evaluate((element) =>
            element.scrollWidth <= element.clientWidth + 1,
          )).toBe(true);
          await expectSizeOptionsToFit(sizeSelect);
          if (size === 'small') {
            await page.screenshot({ path: join(artifactDirectory, `markdown-image-settings-${width}.png`) });
          }
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await browserExpect(page.locator('.mobile-shell')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      }
      for (const { label, width, height } of viewports) {
        await page.setViewportSize({ width, height });
        await browserExpect(page.locator('.mobile-shell')).toHaveCount(label === 'mobile' ? 1 : 0);
        for (const [index, { name, width: naturalWidth, height: naturalHeight }] of renderedImages.entries()) {
          const image = assistant.getByRole('img', { name, exact: true });
          await assistant.locator('.markdown-image').nth(index).scrollIntoViewIfNeeded();
          await expectDecodedImage(image);
          const metrics = await image.evaluate((element) => {
            if (!(element instanceof HTMLImageElement)) throw new Error('Expected image');
            const bounds = element.getBoundingClientRect();
            const markdown = element.closest('.markdown-body')!.getBoundingClientRect();
            return {
              width: bounds.width,
              height: bounds.height,
              left: bounds.left,
              right: bounds.right,
              parentLeft: markdown.left,
              parentRight: markdown.right,
            };
          });
          const expectedWidth = Math.min(
            naturalWidth,
            maxWidth,
            metrics.parentRight - metrics.parentLeft,
            maxHeight * naturalWidth / naturalHeight,
          );
          expect(Math.abs(metrics.width - expectedWidth)).toBeLessThan(1);
          expect(metrics.width).toBeLessThanOrEqual(maxWidth);
          expect(metrics.height).toBeLessThanOrEqual(maxHeight);
          expect(metrics.left).toBeGreaterThanOrEqual(metrics.parentLeft - 1);
          expect(metrics.right).toBeLessThanOrEqual(metrics.parentRight + 1);
          expect(Math.abs(metrics.width / metrics.height - naturalWidth / naturalHeight)).toBeLessThan(0.02);
          if (name === 'Small capture') expect(metrics.width).toBeLessThanOrEqual(160);
        }
        await page.screenshot({ path: join(artifactDirectory, `markdown-images-${size}-${label}.png`) });
      }
    }
    const pixel = await smallImage.evaluate((element) => {
      if (!(element instanceof HTMLImageElement)) throw new Error('Expected image');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.drawImage(element, 0, 0);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    expect(pixel).toEqual([35, 134, 54, 255]);
    expect(externalAuthenticated).toBe(false);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await browserExpect(page.locator('html')).toHaveAttribute('data-inline-image-thumbnail-size', 'large');
    const savedSize = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}').inlineImageThumbnailSize,
    );
    expect(savedSize).toBe('large');
    await browserExpect(assistant.getByRole('img', { name: 'Tall capture', exact: true })).toHaveCSS('max-height', '480px');
    const composer = page.locator('[data-conversation-composer-host] textarea[placeholder="Reply..."]');
    await composer.focus();
    const originalComposer = await composer.elementHandle();
    const composerBounds = await composer.boundingBox();
    for (const target of [otherChatId, chatId, otherChatId, chatId]) {
      await page.locator(`[data-sidebar-virtual-row="${target}"] [data-slot="sidebar-chat-summary"]`)
        .evaluate((element) => element.closest('button')!.click());
      await page.locator(`[data-conversation-panel-chat-id="${target}"]`).waitFor({ state: 'visible' });
    }
    expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
    expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(Math.abs((await composer.boundingBox())!.y - composerBounds!.y)).toBeLessThan(1);
    assertNoBrowserErrors();
  });
}, 180_000);
