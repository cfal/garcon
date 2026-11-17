import { beforeEach, expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { bootstrap, observerKey, requireTarget, visible } from '../../bombadil/browser.js';
import { assertBombadilNotInterrupted } from '../../bombadil/run.js';

beforeEach(assertBombadilNotInterrupted);

test('bootstrap precedes scripts, is exact-origin scoped, and never repairs logout on reload', async () => {
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response(
    '<script>window.tokenAtStartup=localStorage.getItem("bearer-token")</script><p>synthetic</p>',
    { headers: { 'Content-Type': 'text/html' } },
  ) });
  const browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const config = { origin, token: 'synthetic-canary-token', runId: 'canary', chatA: 'a', chatB: 'b', campaign: 'navigation' };
  try {
    const context = await browser.newContext();
    await context.addInitScript({ content: `const observerKey=${JSON.stringify(observerKey)}; (${bootstrap.toString()})(${JSON.stringify(config)});` });
    const page = await context.newPage();
    await page.goto(origin);
    expect(await page.evaluate('window.tokenAtStartup')).toBe(JSON.stringify({ token: config.token, epoch: null }));
    await page.reload();
    expect(await page.evaluate('window.tokenAtStartup')).toBe(JSON.stringify({ token: config.token, epoch: null }));
    await page.evaluate(() => {
      sessionStorage.removeItem('garcon-bombadil-bootstrap');
      localStorage.removeItem('bearer-token');
      localStorage.setItem('garcon.logout-epoch', 'synthetic-epoch');
      localStorage.setItem('pref_local_settings', '{"composerInputMode":"formatted"}');
    });
    await page.reload();
    expect(await page.evaluate('window.tokenAtStartup')).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('pref_local_settings'))).toBe('{"composerInputMode":"formatted"}');
    expect(await page.evaluate(() => window.__bombadil?.documents)).toBe(3);
    await page.goto(origin.replace('127.0.0.1', 'localhost'));
    expect(await page.evaluate(() => localStorage.getItem('bearer-token'))).toBeNull();
    expect(await page.evaluate(() => window.__bombadil)).toBeUndefined();
  } finally { await browser.close(); await server.stop(true); }
});

test('execution-time target checks reject overlays, disabled and detached controls', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="target">Synthetic control</button>');
    await page.addScriptTag({ content: `const visible=${visible.toString()}; window.checkTarget=${requireTarget.toString()};` });
    expect(await page.evaluate('window.checkTarget(document, document.querySelector("button")).id')).toBe('target');
    await page.evaluate(() => { document.querySelector('button')!.disabled = true; });
    const attempt = () => page.evaluate(`(() => { try { window.checkTarget(document, document.querySelector('button')); return false; } catch { return true; } })()`);
    expect(await attempt()).toBe(true);
    await page.evaluate(() => {
      document.querySelector('button')!.disabled = false;
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10';
      document.body.append(overlay);
    });
    expect(await attempt()).toBe(true);
    await page.evaluate(() => document.querySelector('button')!.remove());
    expect(await attempt()).toBe(true);
  } finally { await browser.close(); }
});

test('turn observation preserves responses and retains only acceptance identities', async () => {
  const response = { chatId: 'a', turnId: 'turn', clientRequestId: 'request', token: 'synthetic-private-value' };
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: request => new URL(request.url).pathname === '/api/v1/chats/run'
    ? Response.json(response) : new Response('<p>synthetic</p>', { headers: { 'Content-Type': 'text/html' } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const config = { origin, token: 'synthetic-canary-token', runId: 'canary', chatA: 'a', chatB: 'b', campaign: 'submission' };
    const page = await browser.newPage();
    await page.addInitScript({ content: `const observerKey=${JSON.stringify(observerKey)}; (${bootstrap.toString()})(${JSON.stringify(config)});` });
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const reply = await fetch('/api/v1/chats/run', { method: 'POST', body: JSON.stringify({
        chatId: 'a', clientMessageId: 'message', clientRequestId: 'request', command: 'synthetic-private-command',
      }) });
      return { response: await reply.json(), observation: window.__bombadil };
    });
    expect(result.response).toEqual(response);
    expect(result.observation?.acceptedTurns).toEqual([{ chatId: 'a', turnId: 'turn', clientMessageId: 'message' }]);
    expect(result.observation?.apiErrors).toEqual([]);
    expect(JSON.stringify(result.observation)).not.toContain('synthetic-private');
    await page.reload();
    expect(await page.evaluate(() => window.__bombadil?.acceptedTurns)).toEqual(result.observation?.acceptedTurns);
  } finally { await browser.close(); await server.stop(true); }
});

test('WebSocket readiness follows the replacement socket, not late events from its predecessor', async () => {
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response('<p>synthetic</p>', { headers: { 'Content-Type': 'text/html' } });
    },
    websocket: { message() {} },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const config = { origin, token: 'synthetic-canary-token', runId: 'canary', chatA: 'a', chatB: 'b', campaign: 'navigation' };
    const page = await browser.newPage();
    await page.addInitScript({ content: `const observerKey=${JSON.stringify(observerKey)}; (${bootstrap.toString()})(${JSON.stringify(config)});` });
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const observed = () => window.__bombadil!.documentWsOpen;
      const event = (socket: WebSocket, name: 'open' | 'close') => new Promise<void>(resolve =>
        socket.addEventListener(name, () => resolve(), { once: true }));
      const predecessor = new WebSocket(`ws://${location.host}`);
      await event(predecessor, 'open');
      const initiallyOpen = observed();
      const replacement = new WebSocket(`ws://${location.host}`);
      const replacementPending = observed();
      await event(replacement, 'open');
      const replacementOpen = observed();
      predecessor.close();
      await event(predecessor, 'close');
      const afterStaleClose = observed();
      replacement.close();
      await event(replacement, 'close');
      return { initiallyOpen, replacementPending, replacementOpen, afterStaleClose,
        afterCurrentClose: observed(), wsOpens: window.__bombadil!.wsOpens, wsCloses: window.__bombadil!.wsCloses.length };
    });
    expect(result).toEqual({ initiallyOpen: true, replacementPending: false, replacementOpen: true,
      afterStaleClose: true, afterCurrentClose: false, wsOpens: 2, wsCloses: 2 });
  } finally {
    await browser.close();
    await server.stop(true);
  }
});
