import { expect, test } from 'bun:test';
import { expect as browserExpect, type BrowserContext } from 'playwright/test';
import type { NativeLifecycle } from '../../../web/src/lib/native/lifecycle.js';
import type { NativeServerChooser } from '../../../web/src/lib/native/server-chooser.js';
import type { AuthStatusResponse } from '../../../common/auth.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

type ReadySurface = 'login' | 'setup' | 'shell' | 'recovery' | 'other';

declare global {
  interface Window {
    recordNativeReady(surface: ReadySurface): Promise<void>;
  }
}

async function recordReadiness(context: BrowserContext, reports: ReadySurface[]) {
  await context.exposeBinding('recordNativeReady', (_source, surface: ReadySurface) => {
    reports.push(surface);
  });
  await context.addInitScript(() => {
    const lifecycle = {
      requestReload() {},
      reportReady() {
        let surface: ReadySurface = 'other';
        if (document.querySelector('[data-auth-recovery]')) surface = 'recovery';
        else if (document.querySelector('button[aria-label="More actions"]')) surface = 'shell';
        else if (document.querySelector('input#username') && location.pathname === '/setup') surface = 'setup';
        else if (document.querySelector('input[name="username"]') && location.pathname === '/login') surface = 'login';
        void window.recordNativeReady(surface);
      },
    } satisfies NativeLifecycle;
    Object.defineProperty(window, '__GARCON_NATIVE__', {
      value: { version: 1, requestServerChooser() {}, lifecycle } satisfies NativeServerChooser & { version: 1; lifecycle: NativeLifecycle },
    });
  });
}

test('native readiness follows mounted login, setup, shell and recovery, not auth loading or logout', async () => {
  await withChromiumFixture('native-readiness', async ({ page, context, browser, integration, watchBrowserErrors, consumeExpectedBrowserErrors }) => {
    const base = integration.garcon.baseUrl;
    const reports: ReadySurface[] = [];
    await recordReadiness(context, reports);
    const releaseStatus = new Deferred<void>();
    const statusRequested = new Deferred<void>();
    await page.route('**/api/v1/auth/status', async route => {
      statusRequested.resolve();
      await releaseStatus.promise;
      await route.continue();
    });
    try {
      await page.goto(base);
      await statusRequested.promise;
      await browserExpect(page.getByText('Loading...', { exact: true })).toBeVisible();
      expect(reports).toEqual([]);
      releaseStatus.resolve();
      await browserExpect.poll(() => reports).toEqual(['shell']);
      await page.unroute('**/api/v1/auth/status');

      await page.route('**/api/v1/auth/status', route => route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Synthetic storage fence',
          errorCode: 'AUTH_STORAGE_UNAVAILABLE', retryable: false }),
      }));
      reports.length = 0;
      await page.reload();
      await browserExpect(page.locator('[data-auth-recovery]')).toBeVisible();
      await browserExpect.poll(() => reports).toEqual(['recovery']);
      consumeExpectedBrowserErrors(['console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
      await page.unroute('**/api/v1/auth/status');
      reports.length = 0;
      await page.reload();
      await browserExpect.poll(() => reports).toEqual(['shell']);

      const releaseLogout = new Deferred<void>();
      const logoutRequested = new Deferred<void>();
      await page.route('**/api/v1/auth/logout', async route => {
        logoutRequested.resolve();
        await releaseLogout.promise;
        await route.fulfill({ json: { success: true } });
      });
      try {
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('tab', { name: 'Authentication', exact: true }).click();
        await settings.getByRole('button', { name: 'Log out', exact: true }).click();
        reports.length = 0;
        await page.getByRole('dialog', { name: 'Log out of this browser?', exact: true })
          .getByRole('button', { name: 'Log out', exact: true }).click();
        await logoutRequested.promise;
        await browserExpect(page.getByRole('status')).toHaveText('Logging out...');
        expect(reports).toEqual([]);
        releaseLogout.resolve();
        await browserExpect.poll(() => reports).toEqual(['login']);
      } finally { releaseLogout.resolve(); }
    } finally { releaseStatus.resolve(); }

    const setupContext = await browser.newContext({ serviceWorkers: 'block' });
    watchBrowserErrors(setupContext);
    const setupReports: ReadySurface[] = [];
    await recordReadiness(setupContext, setupReports);
    await setupContext.route('**/api/v1/auth/status', route => route.fulfill({
      json: { needsSetup: true, authDisabled: false, isAuthenticated: false } satisfies AuthStatusResponse,
    }));
    try {
      const setup = await setupContext.newPage();
      await setup.goto(`${base}/setup`);
      await browserExpect(setup.locator('input#username')).toBeVisible();
      await browserExpect.poll(() => setupReports).toEqual(['setup']);
    } finally { await setupContext.close(); }
  });
}, 120_000);
