import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('resumes healthy and silently dead browser sockets without losing the composer draft', async () => {
  await withChromiumFixture('mobile-resume-reconnect', async (fixture, phase) => {
    const { page, context, integration } = fixture;
    let socketCount = 0;
    let pingCount = 0;
    let pongCount = 0;
    let blackholeFirstSocket = false;
    let replacementOpenedAt = 0;
    await context.routeWebSocket('**/ws?*', (socket) => {
      const index = ++socketCount;
      if (index > 1) replacementOpenedAt = performance.now();
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        if (index === 1 && blackholeFirstSocket) return;
        if (typeof message === 'string' && JSON.parse(message).type === 'ws-ping') pingCount++;
        server.send(message);
      });
      server.onMessage((message) => {
        if (index === 1 && blackholeFirstSocket) return;
        if (typeof message === 'string' && JSON.parse(message).type === 'ws-pong') pongCount++;
        socket.send(message);
      });
    });

    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId,
      content: 'Synthetic mobile reconnect check',
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const composer = page.getByPlaceholder('Reply...', { exact: true });
    await browserExpect(composer).toBeVisible();
    await browserExpect.poll(() => socketCount).toBe(1);
    await composer.fill('Synthetic unsent draft');
    const composerBox = await composer.boundingBox();

    phase('checking overlapping resume signals keep the healthy socket');
    const initialPings = pingCount;
    const initialPongs = pongCount;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await browserExpect.poll(() => pingCount).toBe(initialPings + 1);
    await browserExpect.poll(() => pongCount).toBe(initialPongs + 1);
    await browserExpect(composer).toHaveValue('Synthetic unsent draft');
    expect(socketCount).toBe(1);
    expect(await composer.boundingBox()).toEqual(composerBox);

    phase('checking a silent socket is replaced promptly on mobile foregrounding');
    blackholeFirstSocket = true;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const resumedAt = performance.now();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await browserExpect.poll(() => socketCount, { timeout: 4_000 }).toBe(2);
    const replacementDelayMs = replacementOpenedAt - resumedAt;
    expect(replacementDelayMs).toBeLessThan(3_000);
    phase('checking the replacement carries a real processing request');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await browserExpect.poll(() => pongCount).toBeGreaterThan(initialPongs + 1);
    await browserExpect(composer).toHaveValue('Synthetic unsent draft');
    expect(await composer.boundingBox()).toEqual(composerBox);
    expect(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')))
      .toBe('Reply...');

    expect(socketCount).toBe(2);
    console.log(`Mobile foreground socket replacement: ${Math.round(replacementDelayMs)} ms`);

    const screenshots = join(import.meta.dir, '../../artifacts/chromium/mobile-resume-reconnect');
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await browserExpect(composer).toBeVisible();
    await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true });
    fixture.assertNoBrowserErrors();
  });
}, 120_000);
