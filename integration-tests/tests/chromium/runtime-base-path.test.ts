import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import type { ShareChatResponse } from '../../../common/share-types.js';

async function assertMountedAssets(baseUrl: string, basePath: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const shell = await (await fetch(`${baseUrl}/chat/synthetic`)).text();
  expect(shell).toContain(`base: "${basePath}"`);
  expect(shell).not.toContain('__GARCON_RUNTIME_BASE_PATH__');
  for (const path of ['/', '/index.html', '/setup', '/login']) {
    const response = await fetch(baseUrl + path);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`base: "${basePath}"`);
  }
  const assets = [...shell.matchAll(/(?:href|src)="([^"]+)"|import\("([^"]+)"\)/g)]
    .map(match => match[1] ?? match[2]).filter(path => path.startsWith('/'));
  expect(assets.length).toBeGreaterThan(4);
  for (const path of assets) {
    expect(path.startsWith(`${basePath}/`)).toBe(true);
    const response = await fetch(origin + path);
    expect(response.status).toBe(200);
    if (path.startsWith(`${basePath}/_app/immutable/`)) {
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(
        new URL(`../../../web/build${path.slice(basePath.length)}`, import.meta.url),
      ));
    }
  }
  const manifestUrl = `${baseUrl}/site.webmanifest`;
  const manifest = await (await fetch(manifestUrl)).json();
  expect(new URL(manifest.start_url, manifestUrl).href).toBe(`${baseUrl}/`);
  expect(new URL(manifest.scope, manifestUrl).href).toBe(`${baseUrl}/`);
  for (const icon of manifest.icons) expect((await fetch(new URL(icon.src, manifestUrl))).status).toBe(200);
}

for (const basePath of ['', '/garcon', '/tools/garcon']) {
  test(`one build supports navigation, lazy assets and offline shell at ${basePath || '/'}`, async () => {
    await withChromiumFixture(`runtime-mount-${basePath}`, async ({ page, context, integration, assertNoBrowserErrors }) => {
      const baseUrl = integration.garcon.baseUrl;
      await assertMountedAssets(baseUrl, basePath);
      const manifest: Record<string, { name?: string; file: string }> = JSON.parse(await readFile(
        new URL('../../../web/.svelte-kit/output/client/.vite/manifest.json', import.meta.url), 'utf8',
      ));
      const markupChunk = Object.values(manifest).find(entry => entry.name === 'vendor-cm-lang-markup');
      expect(markupChunk).toBeDefined();
      const origin = new URL(baseUrl).origin;
      const requested = new Set<string>();
      const sockets: string[] = [];
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === origin) requested.add(url.pathname);
      });
      page.on('websocket', socket => sockets.push(new URL(socket.url()).pathname));
      await page.goto(`${baseUrl}/api/v1/auth/status`);
      await page.evaluate(async () => {
        const legacy = await caches.open('garcon-pre-prefix-version');
        await legacy.put('/synthetic-legacy-asset.js', new Response('synthetic legacy asset'));
        await caches.open('unrelated');
      });
      await writeFile(join(integration.dirs.project, 'mounted.html'), '<section>Synthetic mounted editor</section>');
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic mounted browser turn',
        projectPath: integration.dirs.project, agent: integration.directAgents.openAi });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await page.goto(`${baseUrl}/chat/${chatId}`);
      await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'mounted.html' })).toBeVisible();
      await browserExpect.poll(() => sockets).toContain(`${basePath}/ws`);
      await page.getByRole('tab', { name: 'Files', exact: true }).click();
      await page.locator('[data-file-tree-entry-text]').filter({ hasText: 'mounted.html' }).click();
      await browserExpect(page.locator('.cm-content .cm-line')).toHaveText('<section>Synthetic mounted editor</section>');
      await browserExpect(page.locator('.cm-content .cm-line span[class]').first()).toBeVisible();
      expect(requested.has(`${basePath}/${markupChunk!.file}`)).toBe(true);
      await page.reload();
      await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'mounted.html' })).toBeVisible();

      const share = await integration.client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
      await page.goto(origin + share.shareUrl);
      await browserExpect(page.getByText('echo:Synthetic mounted browser turn', { exact: true })).toBeVisible();
      await page.locator(`a[href="${basePath}/"]`).first().click();
      await browserExpect(page).toHaveURL(`${baseUrl}/`);
      assertNoBrowserErrors();
      expect([...requested].filter(path => !path.startsWith(`${basePath}/`))).toEqual([]);

      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.reload();
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      const worker = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return { scope: registration.scope, script: registration.active?.scriptURL, caches: await caches.keys() };
      });
      expect(worker.scope).toBe(`${baseUrl}/`);
      expect(worker.script).toBe(`${baseUrl}/service-worker.js`);
      expect(worker.caches.some(name => name.startsWith(`garcon:${encodeURIComponent(basePath)}:`))).toBe(true);
      expect(worker.caches.includes('garcon-pre-prefix-version')).toBe(basePath !== '');
      expect(worker.caches).toContain('unrelated');
      await context.setOffline(true);
      const offline = await page.goto(`${baseUrl}/chat/synthetic-offline`);
      expect(offline?.fromServiceWorker()).toBe(true);
      expect(offline?.status()).toBe(200);
      expect(await offline?.text()).toContain(`base: "${basePath}"`);
      await context.setOffline(false);
    }, undefined, { serverEnvironment: { GARCON_BASE_PATH: basePath }, serviceWorkers: 'allow' });
  }, 120_000);
}
