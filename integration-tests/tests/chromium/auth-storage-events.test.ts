import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('unrelated cross-tab writes skip auth probes while storage-only peer logout still propagates', async () => {
  await withChromiumFixture('auth-storage-events', async ({ page, context, integration, assertNoBrowserErrors }, phase) => {
    const peer = await context.newPage();
    // Exercises the storage fallback rather than letting BroadcastChannel mask a broken listener.
    await peer.addInitScript(() => Object.defineProperty(globalThis, 'BroadcastChannel', { value: undefined }));
    try {
      for (const tab of [page, peer]) {
        await tab.goto(integration.garcon.baseUrl);
        await browserExpect(tab.getByRole('button', { name: 'More actions', exact: true })).toBeVisible();
        await tab.waitForLoadState('networkidle');
      }
      let authRequests = 0;
      peer.on('request', request => {
        if (new URL(request.url()).pathname === '/api/v1/auth/user') authRequests++;
      });
      await peer.waitForTimeout(500);
      const idleRequests = authRequests;
      expect(idleRequests).toBe(0);

      const keys = ['chat_snapshot_synthetic', 'chat_draft_synthetic', 'pref_local_settings'];
      await peer.evaluate(keys => {
        let delivered = 0;
        document.documentElement.dataset.authStorageEvents = '0';
        window.addEventListener('storage', event => {
          if (event.key !== null && keys.includes(event.key)) {
            delivered++;
            document.documentElement.dataset.authStorageEvents = String(delivered);
          }
        });
        sessionStorage.setItem('garcon-ticket-draft-v1:synthetic', 'Synthetic peer draft');
      }, keys);

      phase('measuring unrelated storage writes');
      let expectedStorageEvents = 0;
      for (const key of keys) {
        for (let index = 0; index < 10; index++) {
          await page.evaluate(({ key, index }) => {
            const previous = JSON.parse(localStorage.getItem(key) ?? '{}');
            localStorage.setItem(key, JSON.stringify({ ...previous, syntheticAuthProbe: index }));
          }, { key, index });
          expectedStorageEvents++;
          await browserExpect(peer.locator('html')).toHaveAttribute(
            'data-auth-storage-events', String(expectedStorageEvents));
          // Separates writes so request coalescing cannot hide an unfiltered listener.
          await peer.waitForTimeout(100);
        }
      }
      const requestsDuringWrites = authRequests - idleRequests;
      console.log(JSON.stringify({ idleRequests, unrelatedStorageEvents: expectedStorageEvents, requestsDuringWrites }));
      expect(requestsDuringWrites).toBe(0);

      phase('verifying the peer still reconciles on wake');
      const verified = peer.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/v1/auth/user' && response.status() === 200);
      await peer.evaluate(() => window.dispatchEvent(new Event('online')));
      await verified;
      expect(authRequests).toBe(1);

      phase('logging out with peer BroadcastChannel unavailable');
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: 'Authentication', exact: true }).click();
      await settings.getByRole('button', { name: 'Log out', exact: true }).click();
      await page.getByRole('dialog', { name: 'Log out of this browser?', exact: true })
        .getByRole('button', { name: 'Log out', exact: true }).click();
      await browserExpect(page.getByText('You have been logged out.', { exact: true })).toBeVisible();
      await browserExpect(peer.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect(new URL(peer.url()).searchParams.get('loggedOut')).toBe('peer');
      expect(await peer.evaluate(() => localStorage.getItem('bearer-token'))).toBeNull();
      expect(await peer.evaluate(() => sessionStorage.getItem('garcon-ticket-draft-v1:synthetic'))).toBeNull();
      const revokedSessionResponse = await fetch(`${integration.garcon.baseUrl}/api/v1/auth/user`, {
        headers: { Authorization: `Bearer ${integration.garcon.authToken}` },
      });
      expect(revokedSessionResponse.status).toBe(401);
      assertNoBrowserErrors();
    } finally {
      await peer.close();
    }
  });
}, 120_000);
