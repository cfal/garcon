import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright';

test.each(['touch', 'mouse'] as const)('reconnects a native %s through the Svelte edge anchor', async (pointer) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'canvas-provider-vite-'));
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../../fixtures/canvas-provider', import.meta.url)),
    cacheDir,
    plugins: [svelte({ configFile: false })],
    resolve: {
      dedupe: ['svelte', '@xyflow/system'],
      alias: {
        '@xyflow/svelte': fileURLToPath(new URL('../../../web/node_modules/@xyflow/svelte', import.meta.url)),
      },
    },
    server: { host: '0.0.0.0', port: 0 },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Missing provider fixture address');
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const anchor = page.locator('.svelte-flow__edgeupdater-target');
    await anchor.waitFor();
    const from = (await anchor.boundingBox())!;
    const to = (await page.locator('.svelte-flow__node[data-id="c"] .target').boundingBox())!;
    expect(await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('.svelte-flow__edgeupdater-target') !== null,
    { x: from.x + 2, y: from.y + from.height / 2 })).toBe(true);
    const start = { x: from.x + 2, y: from.y + from.height / 2 };
    const target = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
    if (pointer === 'touch') {
      const protocol = await page.context().newCDPSession(page);
      try {
        await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
        await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...target, id: 1 }] });
        await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await protocol.detach();
      }
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 8 });
      await page.mouse.up();
    }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const result = JSON.parse((await page.locator('output').textContent())!);
    expect(result).toMatchObject({
      edges: [{ source: 'a', target: 'c' }], starts: 1, ends: 1, cancellations: 0,
    });
    expect(await page.locator('.svelte-flow__connection').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}, 60_000);
