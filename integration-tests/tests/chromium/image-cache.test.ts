import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('retains inline images across chat switches and evicts them when the cache budget shrinks', async () => {
  await withChromiumFixture('inline-image-cache', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, directAgents, garcon } = integration;
    const encoded = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1600;
      canvas.height = 900;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#238636';
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const chats: string[] = [];
    for (const name of ['first', 'second', 'third']) {
      await writeFile(join(executionDirs.project, `${name}.png`), Buffer.from(encoded, 'base64'));
      const chatId = integration.newChatId();
      const started = await client.startDirectChat({
        chatId,
        content: `![Cache capture](${name}.png)`,
        projectPath: executionDirs.project,
        agent: directAgents.openAi,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    const requests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname !== '/api/v1/files/content') return;
      expect(url.searchParams.get('executorId')).toBe(client.executorId);
      expect(request.headers().authorization).toBe(`Bearer ${garcon.authToken}`);
      requests.push(url.searchParams.get('path')!);
    });
    await page.goto(`${garcon.baseUrl}/chat/${chats[0]}`);
    const image = page.locator('[data-chat-message-type="assistant-message"]')
      .getByRole('img', { name: 'Cache capture', exact: true });
    async function decoded(): Promise<void> {
      await browserExpect.poll(() => image.evaluate((element) =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth === 1600,
      )).toBe(true);
    }
    async function switchChat(chatId: string): Promise<void> {
      await page.locator(`[data-sidebar-virtual-row="${chatId}"] [data-slot="sidebar-chat-summary"]`)
        .evaluate((element) => element.closest('button')!.click());
      await page.locator(`[data-conversation-panel-chat-id="${chatId}"]`).waitFor({ state: 'visible' });
      await decoded();
    }
    async function openSettings(): Promise<void> {
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    }
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    const sizeSelect = dialog.getByRole('combobox', { name: 'Inline image cache size', exact: true });
    await decoded();
    const originalSource = await image.getAttribute('src');
    await openSettings();
    await browserExpect(sizeSelect).toHaveValue('64');
    expect(await sizeSelect.locator('option').allTextContents()).toEqual(
      [8, 16, 32, 64, 128, 256, 512].map((size) => `${size} MiB`),
    );
    for (const size of [8, 16, 32, 64, 128, 256, 512, 64]) {
      await sizeSelect.selectOption(String(size));
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pref_local_settings')!).imageCacheSizeMiB)).toBe(size);
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const composer = page.locator('[data-conversation-composer-host] textarea[placeholder="Reply..."]');
    await composer.focus();
    const originalComposer = await composer.elementHandle();
    const composerBounds = await composer.boundingBox();
    for (const chatId of [chats[1], chats[2]]) await switchChat(chatId);
    await page.evaluate(() => {
      const samples: Array<{ loading: number; height: number }> = [];
      const monitor = { samples, running: true };
      Object.assign(window, { imageCacheMonitor: monitor });
      function sample(): void {
        if (!monitor.running) return;
        const message = document.querySelector('[data-chat-message-type="assistant-message"]');
        const thumbnail = message?.querySelector('.markdown-image');
        if (thumbnail) samples.push({
          loading: thumbnail.querySelectorAll('[aria-busy="true"]').length,
          height: thumbnail.getBoundingClientRect().height,
        });
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    for (const chatId of [chats[0], chats[1], chats[0]]) await switchChat(chatId);
    await browserExpect.poll(() => page.evaluate(() => Reflect.get(window, 'imageCacheMonitor').samples.length)).toBeGreaterThan(2);
    const frames: Array<{ loading: number; height: number }> = await page.evaluate(() => {
      const monitor = Reflect.get(window, 'imageCacheMonitor');
      monitor.running = false;
      return monitor.samples;
    });
    expect(frames.every((frame) => frame.loading === 0 && Math.abs(frame.height - 320) < 1)).toBe(true);
    expect(requests).toHaveLength(3);
    await browserExpect(image).toHaveAttribute('src', originalSource!);
    expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
    await browserExpect(composer).toBeFocused();
    expect(Math.abs((await composer.boundingBox())!.y - composerBounds!.y)).toBeLessThan(1);
    await originalComposer?.dispose();

    await openSettings();
    await sizeSelect.selectOption('8');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await browserExpect(image).toHaveAttribute('src', originalSource!);
    // Third is the least recently used inactive image; each decoded image is over 5 MiB.
    await switchChat(chats[2]);
    expect(requests.filter((path) => path === 'third.png')).toHaveLength(2);
    // Returning to an older idle image must survive the outgoing chat's release.
    await page.waitForTimeout(1100);
    await switchChat(chats[0]);
    await browserExpect(image).toHaveAttribute('src', originalSource!);

    const artifactDirectory = new URL('../../artifacts/chromium/', import.meta.url).pathname;
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: join(artifactDirectory, 'image-cache-desktop.png') });
    const beforeMobile = requests.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await browserExpect(page.locator('.mobile-shell')).toHaveCount(1);
    await decoded();
    expect(requests).toHaveLength(beforeMobile);
    await browserExpect(image).toHaveAttribute('src', originalSource!);
    await page.screenshot({ path: join(artifactDirectory, 'image-cache-mobile.png') });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await decoded();
    expect(requests.filter((path) => path === 'first.png')).toHaveLength(2);
    await openSettings();
    await browserExpect(sizeSelect).toHaveValue('8');
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 180_000);
