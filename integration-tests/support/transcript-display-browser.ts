import { expect } from 'bun:test';
import type { Page, Response, WebSocketRoute } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { parseBodyDependencyResponse, parseDisplayWindowRequest } from '../../common/transcript-display-contract.js';
import { parsePrimaryWsServerMessage } from '../../common/ws-protocol.js';
import { Deferred, withTimeout } from './deferred.js';

export const DISPLAY_FEED = '[data-chat-scroll-viewport]';

export async function readDisplayWireResponse(response: Pick<Response, 'url' | 'body'>) {
  let bytes: Buffer;
  try { bytes = await response.body(); }
  catch { return null; } // Aborted responses have no body on the receiving socket.
  const operation = new URL(response.url()).pathname.split('/').at(-1)!;
  return { operation, bytes: bytes.length, body: JSON.parse(bytes.toString()) as unknown };
}

export async function observeDisplayWire(page: Page) {
  const http: { operation: string; bytes: number; body: unknown }[] = [];
  const pending = new Set<Promise<void>>();
  const requests: string[] = [];
  const ws: { bytes: number; type: string; chatId: string | null }[] = [];
  const protocolErrors: string[] = [];
  let socket: WebSocketRoute | null = null, connections = 0;
  const droppedChats = new Set<string>();
  await page.routeWebSocket('**/ws?*', route => {
    socket = route; connections++;
    const server = route.connectToServer();
    server.onMessage(payload => {
      const raw = typeof payload === 'string' ? payload : payload.toString();
      let chatId: string | null = null;
      try {
        const data = JSON.parse(raw);
        chatId = typeof data?.chatId === 'string' ? data.chatId : null;
        ws.push({ bytes: Buffer.byteLength(raw), type: typeof data?.type === 'string' ? data.type : '<missing>', chatId });
        if (!parsePrimaryWsServerMessage(data)) protocolErrors.push('Unrecognized browser WebSocket event');
      } catch (error) { protocolErrors.push(String(error)); }
      if (chatId && droppedChats.has(chatId)) return;
      route.send(payload);
    });
  });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes('/chats/')) requests.push(pathname);
  });
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (!pathname.includes('/transcript-display/') || response.status() !== 200) return;
    const read = readDisplayWireResponse(response).then(reply => {
      if (reply) http.push(reply);
    }).catch(() => { protocolErrors.push(`Malformed successful display response: ${pathname}`); });
    pending.add(read);
    void read.finally(() => pending.delete(read));
  });
  return {
    http, ws, requests, droppedChats,
    get connections() { return connections; },
    async reconnect() {
      if (!socket) throw new Error('Browser has no routed socket.');
      const previous = connections;
      socket.close({ code: 1012, reason: 'Synthetic connection gap' });
      await browserExpect.poll(() => connections).toBeGreaterThan(previous);
    },
    async settle() { await Promise.all([...pending]); expect(protocolErrors).toEqual([]); },
    bodies() { return http.filter(item => item.operation === 'bodies').flatMap(item => parseBodyDependencyResponse(item.body).bodies); },
  };
}

export async function holdDisplayResponse(page: Page, operation: 'open' | 'window' | 'bodies', chatId: string) {
  const received = new Deferred<void>(), released = new Deferred<void>(), settled = new Deferred<void>();
  let held = false;
  await page.route(`**/api/v1/chats/transcript-display/${operation}`, async route => {
    const request = route.request().postDataJSON();
    const owner = request.chatId ?? request.certificate?.chatId;
    if (held || owner !== chatId) { await route.continue(); return; }
    held = true;
    try {
      const response = await route.fetch();
      received.resolve();
      await released.promise;
      await route.fulfill({ response });
    } finally { settled.resolve(); }
  });
  return { received: withTimeout(received.promise, 20_000, () => `No held ${operation} response`),
    release: async () => { released.resolve(); if (held) await settled.promise; } };
}

export async function waitForDisplayIdle(page: Page) {
  await page.locator(`${DISPLAY_FEED}[aria-busy="false"]`).first().waitFor();
  await page.locator(DISPLAY_FEED).first().evaluate(async feed => {
    let previous = '', stable = 0;
    for (let frame = 0; frame < 240; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = JSON.stringify([feed.scrollTop, feed.scrollHeight,
        [...feed.querySelectorAll('[data-chat-virtual-item]')].map(item => [item.getAttribute('data-chat-virtual-item'), item.getBoundingClientRect().top])]);
      stable = feed.getAttribute('aria-busy') === 'false' && current === previous ? stable + 1 : 0;
      previous = current;
      if (stable >= 12) return;
    }
    throw new Error('Display geometry did not settle.');
  });
}

export async function sampleDetachedAnchor(page: Page) {
  await page.locator(DISPLAY_FEED).evaluate(feed => {
    feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -500 }));
    feed.scrollTop = Math.max(1, (feed.scrollHeight - feed.clientHeight) / 2);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await browserExpect(page.locator(DISPLAY_FEED)).toHaveAttribute('data-chat-pinned-to-bottom', 'false');
  await waitForDisplayIdle(page);
  await page.evaluate(() => {
    const feed = document.querySelector('[data-chat-scroll-viewport]')!;
    const viewport = feed.getBoundingClientRect();
    const original = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(row => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    });
    if (!original) throw new Error('No fully visible reading row.');
    const expectedOffset = original.getBoundingClientRect().top - viewport.top;
    const capture = { active: true, samples: 0, failures: [] as string[] };
    Object.assign(window, { __displayAnchor: capture });
    const sample = () => {
      if (!capture.active) return;
      capture.samples++;
      if (!original.isConnected) capture.failures.push('Reading node was detached');
      if (Math.abs(original.getBoundingClientRect().top - feed.getBoundingClientRect().top - expectedOffset) > 1)
        capture.failures.push('Reading offset moved');
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  return async () => {
    const result = await page.evaluate(() => {
      const capture = (window as unknown as { __displayAnchor: { active: boolean; samples: number; failures: string[] } }).__displayAnchor;
      capture.active = false;
      return capture;
    });
    expect(result.samples).toBeGreaterThan(2);
    expect(result.failures).toEqual([]);
  };
}

export function displayWindowRequest(postData: string | null) {
  return parseDisplayWindowRequest(JSON.parse(postData ?? 'null'));
}
