import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const SOURCE = [
  '![First](capture.png)',
  'Before image',
  '![Standalone](capture.png)',
  'After image',
  '```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```',
  'After diagram',
  '[![Linked](capture.png)](capture.png)',
  '```mermaid\nflowchart LR\nC[Next] --> D[Done]\n```',
  'Inline ![Inline](capture.png) text',
  '![Last](capture.png)',
  '```mermaid\nflowchart LR\nE[Final] --> F[Step]\n```',
].join('\n\n');

test('spaces standalone chat media without changing inline images on desktop and mobile', async () => {
  await withChromiumFixture('markdown-media-spacing', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, directAgents } = integration;
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#238636';
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await writeFile(join(executionDirs.project, 'capture.png'), Buffer.from(encoded, 'base64'));
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId,
      content: SOURCE,
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const artifacts = new URL('../../artifacts/chromium/', import.meta.url).pathname;
    await mkdir(artifacts, { recursive: true });

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(page.locator('.mobile-shell')).toHaveCount(width === 390 ? 1 : 0);
      for (const role of ['user-message', 'assistant-message']) {
        const row = page.locator(`[data-chat-message-type="${role}"]`);
        const expand = row.getByRole('button', { name: 'Show more', exact: true });
        if (await expand.isVisible()) await expand.click();
        const markdown = row.locator('.markdown-body');
        await browserExpect(markdown.locator('.mermaid-thumbnail')).toHaveCount(3);
        for (const image of await markdown.locator('img').all()) {
          await image.scrollIntoViewIfNeeded();
          await browserExpect.poll(() => image.evaluate((element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
          )).toBe(true);
        }
        const blocks = await markdown.evaluate((element) => Array.from(element.children, (child) => {
          const bounds = child.getBoundingClientRect();
          const style = getComputedStyle(child);
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            marginTop: parseFloat(style.marginTop),
            marginBottom: parseFloat(style.marginBottom),
            paddingTop: parseFloat(style.paddingTop),
            paddingBottom: parseFloat(style.paddingBottom),
          };
        }));
        expect(blocks).toHaveLength(11);
        const mediaIndices = [2, 4, 6, 7, 9, 10];
        if (role === 'user-message') mediaIndices.unshift(0);
        for (const index of mediaIndices) {
          const block = blocks[index];
          expect(block.marginTop).toBe(8);
          expect(block.marginBottom).toBe(8);
          expect(block.paddingTop).toBe(0);
          expect(block.paddingBottom).toBe(0);
          if (index > 0) expect(block.top - blocks[index - 1].bottom).toBeCloseTo(8, 1);
          if (index + 1 < blocks.length) {
            expect(blocks[index + 1].top - block.bottom).toBeCloseTo(8, 1);
          }
        }
        expect(blocks[8].marginTop).toBe(0);
        expect(blocks[8].marginBottom).toBe(4);
        const inline = markdown.getByRole('img', { name: 'Inline', exact: true });
        expect(await inline.evaluate((element) => {
          const style = getComputedStyle(element.closest('.markdown-image')!);
          return { display: style.display, top: style.marginTop, bottom: style.marginBottom };
        })).toEqual({ display: 'inline-block', top: '0px', bottom: '0px' });
        await markdown.getByText('After image', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, `media-spacing-${role}-${width}.png`) });
      }
    }
    assertNoBrowserErrors();
  });
}, 120_000);
