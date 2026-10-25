import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect, type Locator, type Page } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const DIAGRAMS = [
  'flowchart LR\n' + Array.from({ length: 12 }, (_, i) => `N${i}[Stage ${i}] --> N${i + 1}`).join('\n'),
  'flowchart TD\n' + Array.from({ length: 12 }, (_, i) => `N${i}[Stage ${i}] --> N${i + 1}`).join('\n'),
  'sequenceDiagram\nAlice->>Bob: Request\nBob-->>Alice: Response',
  'flowchart LR\nA[Small]\nclick A href "https://example.com/diagram" "Linked node"',
];
const SOURCE = DIAGRAMS.map((source) => '```mermaid\n' + source + '\n```').join('\n\n');
const THUMBNAIL_SIZES = [
  { size: 'small', maxWidth: 320, maxHeight: 180 },
  { size: 'medium', maxWidth: 640, maxHeight: 320 },
  { size: 'large', maxWidth: 960, maxHeight: 480 },
  { size: 'full', maxWidth: Infinity, maxHeight: Infinity },
];
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function expectSizeOptionsToFit(sizeSelect: Locator): Promise<void> {
  const fits = await sizeSelect.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const style = getComputedStyle(select);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = style.font;
    const availableWidth = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return [...select.options].every((option) => context.measureText(option.text).width <= availableWidth);
  });
  expect(fits).toBe(true);
}

async function expectThumbnailBounds(thumbnail: Locator, maxWidth: number, maxHeight: number): Promise<number> {
  await thumbnail.scrollIntoViewIfNeeded();
  const geometry = await thumbnail.locator('svg').first().evaluate((element) => {
    const svg = element as SVGSVGElement;
    const bounds = svg.getBoundingClientRect();
    const markdownBounds = svg.closest('.markdown-body')!.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    return {
      width: bounds.width,
      height: bounds.height,
      right: bounds.right,
      parentRight: markdownBounds.right,
      ratio: viewBox.width / viewBox.height,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.width).toBeLessThanOrEqual(maxWidth + 1);
  expect(geometry.height).toBeLessThanOrEqual(maxHeight + 1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1);
  expect(geometry.overflow).toBe(false);
  expect(Math.abs(geometry.width / geometry.height - geometry.ratio)).toBeLessThan(0.03);
  return geometry.height;
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}

test('sizes unframed Mermaid thumbnails and opens the viewer by click, keyboard, and touch', async () => {
  await withChromiumFixture('mermaid-thumbnails', async ({ page, context, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, directAgents } = integration;
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId,
      content: 'Diagrams\n\n' + SOURCE,
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    const otherChatId = integration.newChatId();
    const other = await client.startDirectChat({
      chatId: otherChatId,
      content: 'Another conversation',
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(otherChatId, other.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const assistant = page.locator('[data-chat-message-type="assistant-message"]');
    const thumbnails = assistant.locator('.mermaid-thumbnail');
    const firstThumbnail = thumbnails.first();
    const firstOpenButton = firstThumbnail.getByRole('button', { name: 'Expand diagram' });
    const firstSvg = firstThumbnail.locator('svg').first();
    const viewer = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true });
    const expandedSvg = viewer.locator('.mermaid-zoom-stage > svg');
    await browserExpect(thumbnails).toHaveCount(DIAGRAMS.length);
    await browserExpect(page.locator('html')).toHaveAttribute('data-inline-mermaid-thumbnail-size', 'medium');
    await browserExpect(assistant.locator('.mermaid-block-header')).toHaveCount(0);
    await browserExpect(assistant.getByRole('button', { name: 'Copy diagram source' })).toHaveCount(0);
    const linkedThumbnail = thumbnails.last();
    const linkedNode = linkedThumbnail.locator('svg a').first();
    const linkedOpenButton = linkedThumbnail.getByRole('button', { name: 'Expand diagram' });
    await linkedThumbnail.scrollIntoViewIfNeeded();
    expect(await linkedNode.evaluate((element) => element.closest('button'))).toBeNull();
    expect(await linkedNode.evaluate((element) => Boolean(element.closest('[inert]')))).toBe(true);
    await linkedOpenButton.focus();
    await linkedNode.evaluate((element) => (element as SVGElement).focus());
    await browserExpect(linkedOpenButton).toBeFocused();
    const linkedBounds = await linkedNode.boundingBox();
    const chatUrl = page.url();
    const pageCount = context.pages().length;
    await page.mouse.click(linkedBounds!.x + linkedBounds!.width / 2, linkedBounds!.y + linkedBounds!.height / 2);
    await browserExpect(viewer).toBeVisible();
    expect(page.url()).toBe(chatUrl);
    expect(context.pages()).toHaveLength(pageCount);
    const viewerLink = expandedSvg.locator('a').first();
    expect(await viewerLink.evaluate((element) => element.getAttribute('href') ?? element.getAttribute('xlink:href'))).toBe('https://example.com/diagram');
    expect(await viewerLink.evaluate((element) => element.closest('[inert]'))).toBeNull();
    await viewerLink.focus();
    await browserExpect(viewerLink).toBeFocused();
    await page.keyboard.press('Escape');
    await browserExpect(viewer).toHaveCount(0);
    await browserExpect(linkedOpenButton).toBeFocused();
    const artifacts = new URL('../../artifacts/chromium/', import.meta.url).pathname;
    await mkdir(artifacts, { recursive: true });

    for (const { size, maxWidth, maxHeight } of THUMBNAIL_SIZES) {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      await browserExpect(page.locator('.mobile-shell')).toHaveCount(0);
      const settings = await openSettings(page);
      const sizeSelect = settings.getByRole('combobox', { name: 'Inline Mermaid thumbnail size (px)' });
      const originalSvg = await firstSvg.elementHandle();
      await sizeSelect.selectOption(size);
      await browserExpect(page.locator('html')).toHaveAttribute('data-inline-mermaid-thumbnail-size', size);
      expect(await firstSvg.evaluate((element, original) => element === original, originalSvg)).toBe(true);
      await originalSvg?.dispose();
      if (size === 'small') {
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await browserExpect(page.locator('.mobile-shell')).toHaveCount(1);
          await sizeSelect.scrollIntoViewIfNeeded();
          expect(await settings.getByRole('tabpanel').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          await expectSizeOptionsToFit(sizeSelect);
          await page.screenshot({ path: join(artifacts, `mermaid-settings-${width}.png`) });
        }
        await page.setViewportSize(DESKTOP_VIEWPORT);
        await browserExpect(page.locator('.mobile-shell')).toHaveCount(0);
      }
      await settings.getByRole('button', { name: 'Close', exact: true }).click();

      for (const viewport of [DESKTOP_VIEWPORT, MOBILE_VIEWPORT]) {
        await page.setViewportSize(viewport);
        await browserExpect(page.locator('.mobile-shell')).toHaveCount(viewport.width === MOBILE_VIEWPORT.width ? 1 : 0);
        await browserExpect(thumbnails).toHaveCount(DIAGRAMS.length);
        for (let i = 0; i < DIAGRAMS.length; i++) {
          const height = await expectThumbnailBounds(thumbnails.nth(i), maxWidth, maxHeight);
          if (size === 'full' && i === 1) expect(height).toBeGreaterThan(480);
        }
        await firstThumbnail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, `mermaid-${size}-${viewport.width}.png`) });
        await firstOpenButton.click();
        await browserExpect(viewer).toBeVisible();
        await browserExpect(expandedSvg).toBeVisible();
        expect((await expandedSvg.boundingBox())!.width).toBeGreaterThan(viewport.width / 2);
        const beforeZoom = await expandedSvg.boundingBox();
        await viewer.getByRole('button', { name: 'Zoom in (+)' }).click();
        await browserExpect.poll(async () => (await expandedSvg.boundingBox())!.width).toBeGreaterThan(beforeZoom!.width);
        await viewer.getByRole('button', { name: 'Fit to window (0)' }).click();
        await page.screenshot({ path: join(artifacts, `mermaid-viewer-${viewport.width}.png`) });
        await page.keyboard.press('Escape');
        await browserExpect(viewer).toHaveCount(0);
        await browserExpect(firstOpenButton).toBeFocused();
      }
    }

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await browserExpect(page.locator('.mobile-shell')).toHaveCount(0);
    await firstOpenButton.focus();
    for (const key of ['Enter', 'Space']) {
      await firstOpenButton.press(key);
      await browserExpect(viewer).toBeVisible();
      await viewer.getByRole('button', { name: 'Close (Escape)' }).click();
      await browserExpect(viewer).toHaveCount(0);
      await browserExpect(firstOpenButton).toBeFocused();
    }
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await firstOpenButton.click();
    await viewer.getByRole('button', { name: 'Copy diagram source' }).click();
    expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(DIAGRAMS[0]);
    await page.keyboard.press('Escape');
    await browserExpect(viewer).toHaveCount(0);
    await page.reload();
    await browserExpect(page.locator('html')).toHaveAttribute('data-inline-mermaid-thumbnail-size', 'full');

    const composer = page.locator('[data-conversation-composer-host] textarea[placeholder="Reply..."]');
    await composer.fill('Retained draft');
    await composer.focus();
    const originalComposer = await composer.elementHandle();
    const originalBounds = await composer.boundingBox();
    for (const target of [otherChatId, chatId, otherChatId, chatId]) {
      await page.locator(`[data-sidebar-virtual-row="${target}"] [data-slot="sidebar-chat-summary"]`)
        .evaluate((element) => element.closest('button')!.click());
      await page.locator(`[data-conversation-panel-chat-id="${target}"]`).waitFor({ state: 'visible' });
    }
    expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
    await browserExpect(composer).toHaveValue('Retained draft');
    await browserExpect(composer).toBeFocused();
    expect(Math.abs((await composer.boundingBox())!.y - originalBounds!.y)).toBeLessThan(1);
    await originalComposer?.dispose();

    await linkedOpenButton.click();
    await browserExpect(viewer).toBeVisible();
    await context.route('https://example.com/diagram', (route) => route.fulfill({ body: 'Linked diagram target' }));
    await viewerLink.click();
    await browserExpect(page).toHaveURL('https://example.com/diagram');

    const touchContext = await context.browser()!.newContext({
      storageState: await context.storageState(),
      viewport: MOBILE_VIEWPORT,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
    });
    try {
      const touchPage = await touchContext.newPage();
      await touchPage.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const touchThumbnail = touchPage.locator('[data-chat-message-type="assistant-message"] .mermaid-thumbnail').first();
      await touchThumbnail.tap();
      const touchViewer = touchPage.getByRole('dialog', { name: 'Mermaid diagram', exact: true });
      await browserExpect(touchViewer).toBeVisible();
      const header = touchViewer.locator('header');
      expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await touchViewer.getByRole('button', { name: 'Close (Escape)' }).tap();
      await browserExpect(touchViewer).toHaveCount(0);
      await touchContext.route('https://example.com/diagram', (route) => route.fulfill({ body: 'Linked diagram target' }));
      await touchPage.locator('[data-chat-message-type="assistant-message"] .mermaid-thumbnail').last().tap();
      await browserExpect(touchViewer).toBeVisible();
      await touchViewer.locator('svg a').first().tap();
      await browserExpect(touchPage).toHaveURL('https://example.com/diagram');
    } finally {
      await touchContext.close();
    }
    assertNoBrowserErrors();
  });
}, 180_000);
