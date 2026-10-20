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
      { size: 'full', maxWidth: Infinity, maxHeight: Infinity },
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
    await browserExpect(page.locator('html')).toHaveAttribute('data-inline-image-thumbnail-size', 'full');
    const savedSize = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}').inlineImageThumbnailSize,
    );
    expect(savedSize).toBe('full');
    await browserExpect(assistant.getByRole('img', { name: 'Tall capture', exact: true })).toHaveCSS('max-height', 'none');
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
    await assistant.getByRole('button', { name: 'Open image Small capture', exact: true }).click();
    await expectDecodedImage(page.getByRole('img', { name: 'small.png', exact: true }));
    assertNoBrowserErrors();
  });
}, 180_000);

test('opens remote thumbnails in the image viewer with mouse, keyboard, and mobile controls', async () => {
  await withChromiumFixture('markdown-image-viewer', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, directAgents, garcon } = integration;
    await writeFile(join(executionDirs.project, 'capture.png'), await createImageBuffer(page, { width: 1400, height: 900 }));
    await writeFile(join(executionDirs.project, 'linked.md'), '# Linked document');
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId,
      content: '![Capture](capture.png)\n\n[![Linked capture](capture.png)](linked.md)',
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
      localStorage.setItem('pref_local_settings', JSON.stringify({ ...settings, imageViewerOpenPlacement: 'dialog' }));
    });
    const contentRequests: Array<{ url: string; authorization?: string }> = [];
    const releaseContent = new Deferred<void>();
    await page.route('**/api/v1/files/content?**', async (route) => {
      contentRequests.push({ url: route.request().url(), authorization: route.request().headers().authorization });
      await releaseContent.promise;
      await route.continue();
    });
    await page.goto(`${garcon.baseUrl}/chat/${chatId}`);
    const assistant = page.locator('[data-chat-message-type="assistant-message"]');
    const thumbnail = assistant.getByRole('button', { name: 'Open image Capture', exact: true });
    const thumbnailImage = thumbnail.getByRole('img');
    const imageLink = assistant.getByRole('link', { name: 'Linked capture', exact: true });
    const dialog = page.locator('[role="dialog"][data-workspace-surface-id^="file:"]');
    const expandedImage = dialog.getByRole('img', { name: 'capture.png', exact: true });
    try {
      const spinner = assistant.getByRole('status', { name: 'Loading image...' }).first();
      await browserExpect(spinner.locator('svg.animate-spin')).toBeVisible();
      await browserExpect(spinner).toHaveText('');
      await browserExpect(spinner).toHaveAttribute('aria-busy', 'true');
      await browserExpect(thumbnail).toHaveCount(0);
    } finally {
      releaseContent.resolve();
    }
    await expectDecodedImage(thumbnailImage);
    const thumbnailSource = await thumbnailImage.getAttribute('src');
    await browserExpect(imageLink.locator('button')).toHaveCount(0);
    const artifactDirectory = new URL('../../artifacts/chromium/', import.meta.url).pathname;
    await mkdir(artifactDirectory, { recursive: true });
    for (const activation of ['click', 'Enter', 'Space']) {
      if (activation === 'click') {
        await thumbnailImage.click();
      } else {
        await thumbnail.press(activation);
      }
      await expectDecodedImage(expandedImage);
      expect(await expandedImage.getAttribute('src')).not.toBe(thumbnailSource);
      await browserExpect(dialog.getByRole('button', { name: 'Fit to window (0)', exact: true })).toBeVisible();
      const beforeZoom = await expandedImage.boundingBox();
      await dialog.getByRole('button', { name: 'Zoom in (+)', exact: true }).click();
      await browserExpect.poll(async () => (await expandedImage.boundingBox())!.width).toBeGreaterThan(beforeZoom!.width);
      if (activation === 'click') {
        await page.screenshot({ path: join(artifactDirectory, 'markdown-image-viewer-desktop.png') });
      }
      await page.keyboard.press('Escape');
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(thumbnail).toBeFocused();
      await expectDecodedImage(thumbnailImage);
    }
    expect(contentRequests.length).toBeGreaterThanOrEqual(3);
    for (const request of contentRequests) {
      const query = new URL(request.url).searchParams;
      expect(query.get('executorId')).toBe(client.executorId);
      expect(query.get('projectPath')).toBe(executionDirs.project);
      expect(query.get('path')).toBe('capture.png');
      expect(request.authorization).toBe(`Bearer ${garcon.authToken}`);
    }
    await imageLink.click();
    await browserExpect(page.getByRole('heading', { name: 'Linked document', exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${garcon.baseUrl}/chat/${chatId}`);
    await browserExpect(page.locator('.mobile-shell')).toHaveCount(1);
    await thumbnail.click();
    const mobileImage = page.getByRole('img', { name: 'capture.png', exact: true });
    await expectDecodedImage(mobileImage);
    await browserExpect(page.getByRole('button', { name: 'Fit to window (0)', exact: true })).toBeVisible();
    await page.screenshot({ path: join(artifactDirectory, 'markdown-image-viewer-mobile.png') });
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 180_000);
