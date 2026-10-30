import { createServer, type Socket } from 'node:net';
import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

interface ResumeFaults {
  sockets: WebSocket[];
  opens: number[];
  clientCloses: number;
  failUpgrade: boolean;
  stallUpgrade: boolean;
  authFault: 'fail' | 'stall' | null;
  authFailures: number;
  authTimeouts: number;
  authSuccesses: number;
  resumedAt: number;
  onlineAt: number;
}

declare global {
  interface Window {
    resumeFaults: ResumeFaults;
  }
}

async function installFaults(page: Page, port: number): Promise<void> {
  await page.addInitScript((port) => {
    const faults: ResumeFaults = window.resumeFaults = {
      sockets: [], opens: [], clientCloses: 0,
      failUpgrade: false, stallUpgrade: false, authFault: null,
      authFailures: 0, authTimeouts: 0, authSuccesses: 0,
      resumedAt: 0, onlineAt: 0,
    };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        let target = url;
        if (faults.failUpgrade || faults.stallUpgrade) {
          target = `ws://127.0.0.1:${port}/${faults.failUpgrade ? 'fail' : 'stall'}`;
          faults.failUpgrade = false;
          faults.stallUpgrade = false;
        }
        super(target, protocols);
        faults.sockets.push(this);
        this.addEventListener('open', () => faults.opens.push(performance.now()));
      }
      override close(code?: number, reason?: string): void {
        faults.clientCloses++;
        super.close(code, reason);
      }
    };
    const nativeFetch = window.fetch.bind(window);
    window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const isAuth = new URL(url, location.href).pathname.endsWith('/api/v1/auth/user');
      const fault = isAuth ? faults.authFault : null;
      if (fault) faults.authFault = null;
      if (fault === 'fail') {
        faults.authFailures++;
        throw new TypeError('Synthetic resume network failure');
      }
      if (fault === 'stall') {
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
          const abort = () => {
            faults.authTimeouts++;
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      const response = await nativeFetch(input, init);
      if (isAuth && response.ok) faults.authSuccesses++;
      return response;
    }, nativeFetch);
  }, port);
}

async function background(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    for (const socket of window.resumeFaults.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  });
  await browserExpect.poll(() => page.evaluate(() =>
    window.resumeFaults.sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
  )).toBe(true);
}

async function foreground(page: Page): Promise<void> {
  // Standalone mobile app switches need no pageshow event, which can mask auth failures.
  await page.evaluate(() => {
    window.resumeFaults.resumedAt = performance.now();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function expectRecovery(page: Page, previousOpens: number, budgetMs: number): Promise<void> {
  await browserExpect.poll(() => page.evaluate(() => window.resumeFaults.opens.length), {
    timeout: budgetMs + 500,
    intervals: [25, 50, 100],
  }).toBe(previousOpens + 1);
  const delay = await page.evaluate(() => {
    const faults = window.resumeFaults;
    return faults.opens.at(-1)! - faults.resumedAt;
  });
  expect(delay).toBeLessThan(budgetMs);
  console.log(`Mobile resume recovery: ${Math.round(delay)} ms`);
}

test('recovers through auth faults, stalled upgrades and repeated quick app switches', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (data) => {
      if (data.toString().startsWith('GET /fail '))
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fault-server port');
  try {
    await withChromiumFixture('mobile-resume-failures', async ({ page, integration, withExpectedConsoleErrors }, phase) => {
      await installFaults(page, address.port);
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId, content: 'Synthetic mobile fault recovery',
        projectPath: integration.dirs.project, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const composer = page.getByPlaceholder('Reply...', { exact: true });
      await browserExpect(composer).toBeVisible({ timeout: 20_000 });
      await browserExpect.poll(() => page.evaluate(() => window.resumeFaults.opens.length)).toBe(1);
      await composer.fill('Synthetic retained draft');
      const box = await composer.boundingBox();

      phase('failed auth revalidation retains the replacement socket');
      await background(page);
      const successes = await page.evaluate(() => window.resumeFaults.authSuccesses);
      await page.evaluate(() => { window.resumeFaults.authFault = 'fail'; });
      await foreground(page);
      await expectRecovery(page, 1, 1_500);
      expect(await page.evaluate(() => window.resumeFaults.authFailures)).toBe(1);
      await browserExpect.poll(() => page.evaluate(() => window.resumeFaults.authSuccesses), {
        timeout: 4_000,
      }).toBeGreaterThan(successes);
      expect(await page.evaluate(() => window.resumeFaults.opens.length)).toBe(2);

      phase('a timed-out auth probe cannot tear down the recovered socket');
      await background(page);
      const closes = await page.evaluate(() => window.resumeFaults.clientCloses);
      await page.evaluate(() => { window.resumeFaults.authFault = 'stall'; });
      await foreground(page);
      await expectRecovery(page, 2, 1_500);
      await browserExpect.poll(() => page.evaluate(() => window.resumeFaults.authTimeouts), {
        timeout: 7_000,
      }).toBe(1);
      expect(await page.evaluate(() => window.resumeFaults.clientCloses)).toBe(closes);
      expect(await page.evaluate(() => window.resumeFaults.opens.length)).toBe(3);

      phase('online replaces an upgrade stalled before the network returned');
      await background(page);
      await page.evaluate(() => { window.resumeFaults.stallUpgrade = true; });
      await foreground(page);
      await page.evaluate(() => {
        setTimeout(() => {
          window.resumeFaults.onlineAt = performance.now();
          window.dispatchEvent(new Event('online'));
        }, 500);
      });
      await expectRecovery(page, 3, 1_500);
      expect(await page.evaluate(() => {
        const faults = window.resumeFaults;
        return faults.opens.at(-1)! - faults.onlineAt;
      })).toBeLessThan(1_000);

      phase('quick switches restart backoff after each failed upgrade');
      for (let cycle = 0; cycle < 4; cycle++) {
        await withExpectedConsoleErrors([
          'WebSocket error: {readyState: 3, visibilityState: visible, online: true}',
          `WebSocket connection to 'ws://127.0.0.1:${address.port}/fail' failed: Error during WebSocket handshake: Unexpected response code: 503`,
        ], async () => {
          await background(page);
          await page.evaluate(() => { window.resumeFaults.failUpgrade = true; });
          await foreground(page);
          await expectRecovery(page, 4 + cycle, 1_200);
        });
        await browserExpect(composer).toHaveValue('Synthetic retained draft');
        expect(await composer.boundingBox()).toEqual(box);
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
      }
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 120_000);
