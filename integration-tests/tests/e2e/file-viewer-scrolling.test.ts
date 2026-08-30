import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const MARKDOWN_FILE = 'scrolling.md';
const TEXT_FILE = 'scrolling.txt';
const IMAGE_FILE = 'scrolling.svg';

type ScrollTarget = 'markdown' | 'editor' | 'image';

describe('Lightpanda desktop file viewer scrolling', () => {
  test('preserves editor, Markdown, and image offsets across tab switches', async () => {
    await withE2eFixture('file-viewer-scrolling', async (fixture) => {
      const projectPath = fixture.integration.dirs.project;
      await Promise.all([
        writeFile(
          join(projectPath, MARKDOWN_FILE),
          Array.from({ length: 240 }, (_, index) => `## Section ${index}\n\nBody ${index}.`).join(
            '\n\n',
          ),
          'utf8',
        ),
        writeFile(
          join(projectPath, TEXT_FILE),
          Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n'),
          'utf8',
        ),
        writeFile(
          join(projectPath, IMAGE_FILE),
          '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1800" viewBox="0 0 2400 1800"><rect width="2400" height="1800" fill="#fff"/><path d="M0 0 2400 1800M2400 0 0 1800" stroke="#111" stroke-width="24"/></svg>',
          'utf8',
        ),
      ]);

      await fixture.page.evaluateOnNewDocument(() => {
        const key = 'pref_local_settings';
        const parsed = JSON.parse(globalThis.localStorage.getItem(key) ?? '{}') as unknown;
        const stored = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        globalThis.localStorage.setItem(
          key,
          JSON.stringify({
            ...stored,
            textEditorOpenPlacement: 'same-window',
            imageViewerOpenPlacement: 'same-window',
            markdownViewerOpenPlacement: 'same-window',
          }),
        );
      });

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('file-viewer-scroll-seed', {
        projectPath,
      });
      await app.openNewWorkspaceWindow('Open Files');
      const filesWindowId = await app.workspaceWindowIdForSurface('singleton:files');
      await fixture.page.waitForSelector('[data-file-tree-grid]');

      await openProjectFile(
        fixture.page,
        join(projectPath, MARKDOWN_FILE),
        MARKDOWN_FILE,
        'markdown',
      );
      await app.selectWorkspaceWindowSurface('Files', filesWindowId);
      await openProjectFile(fixture.page, join(projectPath, TEXT_FILE), TEXT_FILE, 'editor');
      await app.selectWorkspaceWindowSurface('Files', filesWindowId);
      await openProjectFile(fixture.page, join(projectPath, IMAGE_FILE), IMAGE_FILE, 'image');

      await app.selectWorkspaceWindowSurface(MARKDOWN_FILE, filesWindowId);
      await waitForActiveTarget(fixture.page, MARKDOWN_FILE, 'markdown');
      const markdownOffset = await setScrollOffset(fixture.page, MARKDOWN_FILE, 'markdown', 420);
      expect(markdownOffset).toBeGreaterThan(0);
      await app.selectWorkspaceWindowSurface(TEXT_FILE, filesWindowId);
      await app.selectWorkspaceWindowSurface(MARKDOWN_FILE, filesWindowId);
      await expectRestoredOffset(fixture.page, MARKDOWN_FILE, 'markdown', markdownOffset);

      await app.selectWorkspaceWindowSurface(TEXT_FILE, filesWindowId);
      await waitForActiveTarget(fixture.page, TEXT_FILE, 'editor');
      const editorOffset = await setScrollOffset(fixture.page, TEXT_FILE, 'editor', 560);
      expect(editorOffset).toBeGreaterThan(0);
      await app.selectWorkspaceWindowSurface(IMAGE_FILE, filesWindowId);
      await app.selectWorkspaceWindowSurface(TEXT_FILE, filesWindowId);
      await expectRestoredOffset(fixture.page, TEXT_FILE, 'editor', editorOffset);

      await app.selectWorkspaceWindowSurface(IMAGE_FILE, filesWindowId);
      await waitForActiveTarget(fixture.page, IMAGE_FILE, 'image');
      await prepareScrollableImage(fixture.page, IMAGE_FILE);
      await app.clickButton('Zoom in', { contains: true });
      await app.clickButton('Zoom in', { contains: true });
      await waitForAnimationFrames(fixture.page, 3);
      const imageOffset = await setScrollOffset(fixture.page, IMAGE_FILE, 'image', 360);
      expect(imageOffset).toBeGreaterThan(0);
      await app.selectWorkspaceWindowSurface(MARKDOWN_FILE, filesWindowId);
      await app.selectWorkspaceWindowSurface(IMAGE_FILE, filesWindowId);
      await expectRestoredOffset(fixture.page, IMAGE_FILE, 'image', imageOffset);

      fixture.assertNoBrowserErrors();
    });
  });
});

async function openProjectFile(
  page: Page,
  absolutePath: string,
  fileName: string,
  target: ScrollTarget,
): Promise<void> {
  await page.waitForFunction(
    (path) =>
      [...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]')].some(
        (element) => element.getAttribute('title') === path,
      ),
    { timeout: 20_000 },
    absolutePath,
  );
  await page.evaluate((path) => {
    const header = [
      ...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]'),
    ].find((element) => element.getAttribute('title') === path);
    const row = header?.closest<HTMLElement>('[data-file-tree-row]');
    if (!row) throw new Error(`Missing file tree row: ${path}`);
    row.click();
  }, absolutePath);
  await waitForActiveTarget(page, fileName, target);
}

async function waitForActiveTarget(
  page: Page,
  fileName: string,
  target: ScrollTarget,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedFileName, expectedTarget }) => {
      const surface = [
        ...document.querySelectorAll<HTMLElement>('[data-workspace-surface-id^="file:"]'),
      ].find(
        (candidate) => candidate.querySelector('h2')?.textContent?.trim() === expectedFileName,
      );
      if (!surface) return false;
      if (expectedTarget === 'markdown')
        return surface.querySelector('.markdown-viewer-content') !== null;
      if (expectedTarget === 'editor') return surface.querySelector('.cm-scroller') !== null;
      return surface.querySelector(`img[alt="${expectedFileName}"]`) !== null;
    },
    { timeout: 20_000 },
    { expectedFileName: fileName, expectedTarget: target },
  );
  if (target === 'editor') await waitForAnimationFrames(page, 1);
}

async function setScrollOffset(
  page: Page,
  fileName: string,
  target: ScrollTarget,
  offset: number,
): Promise<number> {
  return await page.evaluate(
    ({ expectedFileName, expectedTarget, expectedOffset }) => {
      const surface = [
        ...document.querySelectorAll<HTMLElement>('[data-workspace-surface-id^="file:"]'),
      ].find(
        (candidate) => candidate.querySelector('h2')?.textContent?.trim() === expectedFileName,
      );
      const element =
        expectedTarget === 'markdown'
          ? surface?.querySelector<HTMLElement>('.markdown-viewer-content')
          : expectedTarget === 'editor'
            ? surface?.querySelector<HTMLElement>('.cm-scroller')
            : surface?.querySelector<HTMLImageElement>(`img[alt="${expectedFileName}"]`)
                ?.closest<HTMLElement>('.overflow-auto');
      if (!element)
        throw new Error(`Missing ${expectedTarget} scroll target for ${expectedFileName}`);
      element.scrollTop = expectedOffset;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
      return element.scrollTop;
    },
    {
      expectedFileName: fileName,
      expectedTarget: target,
      expectedOffset: offset,
    },
  );
}

async function expectRestoredOffset(
  page: Page,
  fileName: string,
  target: ScrollTarget,
  expectedOffset: number,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedFileName, expectedTarget, expected }) => {
      const surface = [
        ...document.querySelectorAll<HTMLElement>('[data-workspace-surface-id^="file:"]'),
      ].find(
        (candidate) => candidate.querySelector('h2')?.textContent?.trim() === expectedFileName,
      );
      const element =
        expectedTarget === 'markdown'
          ? surface?.querySelector<HTMLElement>('.markdown-viewer-content')
          : expectedTarget === 'editor'
            ? surface?.querySelector<HTMLElement>('.cm-scroller')
            : surface?.querySelector<HTMLImageElement>(`img[alt="${expectedFileName}"]`)
                ?.closest<HTMLElement>('.overflow-auto');
      const tolerance = expectedTarget === 'image' ? 4 : 1;
      return element != null && Math.abs(element.scrollTop - expected) <= tolerance;
    },
    { timeout: 20_000 },
    {
      expectedFileName: fileName,
      expectedTarget: target,
      expected: expectedOffset,
    },
  );
}

async function prepareScrollableImage(page: Page, fileName: string): Promise<void> {
  await page.evaluate((expectedFileName) => {
    const surface = [
      ...document.querySelectorAll<HTMLElement>('[data-workspace-surface-id^="file:"]'),
    ].find((candidate) => candidate.querySelector('h2')?.textContent?.trim() === expectedFileName);
    const target = surface?.querySelector<HTMLImageElement>(`img[alt="${expectedFileName}"]`);
    if (!target) throw new Error(`Missing image: ${expectedFileName}`);
    // Supplies layout dimensions because Lightpanda does not decode blob-backed SVG metadata.
    const style = document.createElement('style');
    style.textContent = `img[alt="${expectedFileName}"] { width: 2400px !important; height: 1800px !important; }`;
    document.head.append(style);
  }, fileName);
}

async function waitForAnimationFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}
