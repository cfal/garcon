import { expect, test } from 'bun:test';
import { expect as browserExpect, type Page } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import type { TicketBootstrap, TicketWriteResult } from '../../../common/tickets.js';

async function authenticationSettings(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Authentication', exact: true }).click();
  return settings;
}

async function privateDatabaseRows(page: Page, seed: boolean): Promise<number[]> {
  return page.evaluate(async (seed) => {
    const counts: number[] = [];
    for (const { name, version, stores } of [
      { name: 'garcon-file-drafts-v1', version: 2, stores: { drafts: 'documentId', recents: 'key', navigation: 'key' } },
      { name: 'garcon-local-media', version: 1, stores: { 'completion-sounds': null } },
    ]) {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => {
          for (const [store, keyPath] of Object.entries(stores)) {
            if (!request.result.objectStoreNames.contains(store))
              request.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        for (const [store, keyPath] of Object.entries(stores)) {
          counts.push(await new Promise<number>((resolve, reject) => {
            const transaction = database.transaction(store, seed ? 'readwrite' : 'readonly');
            const records = transaction.objectStore(store);
            if (seed) {
              if (keyPath) records.put({ [keyPath]: 'synthetic', content: 'Synthetic private content' });
              else records.put(new Blob(['Synthetic private media']), 'synthetic');
            }
            const count = records.count();
            transaction.oncomplete = () => resolve(count.result);
            transaction.onabort = transaction.onerror = () => reject(transaction.error);
          }));
        }
      } finally { database.close(); }
    }
    return counts;
  }, seed);
}

test('confirmed logout clears browser data and sibling tabs but not another device', async () => {
  await withChromiumFixture('browser-logout', async ({ page, context, browser, integration }, phase) => {
    await context.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
    const base = integration.garcon.baseUrl;
    const bootstrap = await integration.client.get<TicketBootstrap>('/api/v1/tickets/bootstrap');
    const created = await integration.client.post<TicketWriteResult>('/api/v1/tickets/mutate', {
      requestId: crypto.randomUUID(), expectedStoreId: bootstrap.storeId,
      payload: { action: 'create', input: { title: 'Synthetic logout ticket', project: 'Project' } },
    });
    const peer = await context.newPage();
    let exitDialogs = 0;
    for (const tab of [page, peer]) {
      tab.on('dialog', dialog => { exitDialogs++; void dialog.dismiss(); });
      await tab.goto(`${base}/?ticket=${created.ticket.id}`);
      await tab.getByRole('button', { name: 'Edit', exact: true }).click();
      await tab.getByLabel('Title', { exact: true }).fill('Synthetic unsaved draft');
    }
    expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
    const otherContext = await browser.newContext({ serviceWorkers: 'block' });
    const other = await otherContext.newPage();
    try {
      await other.goto(`${base}/login`);
      await other.getByLabel('Username', { exact: true }).fill(integration.garcon.credentials!.username);
      await other.getByLabel('Password', { exact: true }).fill(integration.garcon.credentials!.password);
      await other.getByRole('button', { name: 'Sign in', exact: true }).click();
      await browserExpect(other.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
      await page.evaluate(() => {
        localStorage.setItem('chat_draft_synthetic', 'Synthetic private draft');
        localStorage.setItem('chat_snapshot_synthetic', 'Synthetic private snapshot');
        localStorage.setItem('unrelated-app', 'Preserved');
        sessionStorage.setItem('garcon-ticket-draft-v1:synthetic', 'Synthetic ticket draft');
      });
      await peer.evaluate(() => sessionStorage.setItem('chat-canvas-recovery-v1:synthetic', 'Synthetic canvas draft'));
      expect(await privateDatabaseRows(page, true)).toEqual([1, 1, 1, 1]);
      const settings = await authenticationSettings(page);
      await settings.getByRole('button', { name: 'Log out', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: 'Log out of this browser?', exact: true });
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(settings).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('chat_draft_synthetic'))).not.toBeNull();
      phase('confirming logout');
      await settings.getByRole('button', { name: 'Log out', exact: true }).click();
      await confirm.getByRole('button', { name: 'Log out', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await browserExpect(peer.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect(exitDialogs).toBe(0);
      await browserExpect(page.getByText('You have been logged out.', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem('chat_draft_synthetic'))).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('chat_snapshot_synthetic'))).toBeNull();
      expect(await page.evaluate(() => sessionStorage.getItem('garcon-ticket-draft-v1:synthetic'))).toBeNull();
      expect(await peer.evaluate(() => sessionStorage.getItem('chat-canvas-recovery-v1:synthetic'))).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('unrelated-app'))).toBe('Preserved');
      expect(await privateDatabaseRows(page, false)).toEqual([0, 0, 0, 0]);
      expect((await fetch(`${base}/api/v1/auth/user`, { headers: { Authorization: `Bearer ${integration.garcon.authToken}` } })).status).toBe(401);
      await browserExpect(other.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
      const independentToken = await other.evaluate(() => (JSON.parse(localStorage.getItem('bearer-token') ?? 'null')?.token ?? null));
      expect((await fetch(`${base}/api/v1/auth/user`, { headers: { Authorization: `Bearer ${independentToken}` } })).status).toBe(200);
      phase('fresh sign-in after logout');
      await page.getByLabel('Username', { exact: true }).fill(integration.garcon.credentials!.username);
      await page.getByLabel('Password', { exact: true }).fill(integration.garcon.credentials!.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
    } finally { await peer.close(); await otherContext.close(); }
  });
}, 120_000);

test('offline logout still abandons the browser and reports unconfirmed server revocation', async () => {
  await withChromiumFixture('browser-logout-offline', async ({ page, integration }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.route('**/api/v1/auth/logout', route => route.abort('failed'));
    const settings = await authenticationSettings(page);
    await settings.getByRole('button', { name: 'Log out', exact: true }).click();
    await page.getByRole('dialog', { name: 'Log out of this browser?', exact: true })
      .getByRole('button', { name: 'Log out', exact: true }).click();
    await browserExpect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await browserExpect(page.getByText('Local access was removed, but the server could not confirm logout.', { exact: false })).toBeVisible();
    await page.reload();
    await browserExpect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
}, 120_000);
