import { expect, test } from 'bun:test';
import { expect as browserExpect, type Page, type Route } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TicketBootstrap, TicketWriteResult } from '../../../common/tickets.js';
import { authenticateChromiumContext, withChromiumFixture } from '../../support/chromium-fixture.js';
import { withTimeout } from '../../support/deferred.js';

async function openPasswordSettings(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Password', exact: true }).click();
  return settings;
}

async function retainTicket(page: Page, baseUrl: string, ticketId: string, text: string) {
  await page.goto(`${baseUrl}/?ticket=${ticketId}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const title = page.getByLabel('Title', { exact: true });
  await title.fill(text);
  await title.evaluate(element => element.setAttribute('data-retained-ticket', 'true'));
}

test('separate credential forms retain source, sibling, and other-device work on desktop and mobile', async () => {
  await withChromiumFixture('account-credentials-continuity', async ({ page, context, browser, integration }, phase) => {
    const credentials = integration.garcon.credentials!;
    const bootstrap = await integration.client.get<TicketBootstrap>('/api/v1/tickets/bootstrap');
    const created = await integration.client.post<TicketWriteResult>('/api/v1/tickets/mutate', {
      requestId: crypto.randomUUID(), expectedStoreId: bootstrap.storeId,
      payload: { action: 'create', input: { title: 'Synthetic ticket', project: 'Project' } },
    });
    const peer = await context.newPage();
    const otherContext = await browser.newContext({ serviceWorkers: 'block' });
    await authenticateChromiumContext(otherContext, integration);
    const other = await otherContext.newPage();
    try {
      for (const [target, text] of [[page, 'Source draft'], [peer, 'Sibling draft'], [other, 'Other-device draft']] as const) {
        await retainTicket(target, integration.garcon.baseUrl, created.ticket.id, text);
      }
      const settings = await openPasswordSettings(page);
      await settings.evaluate(element => element.setAttribute('data-retained-settings', 'true'));
      const committed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await page.route('**/api/v1/auth/username', async route => {
        const response = await route.fetch(); committed.resolve(); await release.promise;
        await route.fulfill({ response });
      });
      await settings.locator('#account-username').fill('owner-after');
      await settings.locator('#username-current-password').fill(credentials.password);
      await settings.locator('#username-current-password').press('Enter');
      await committed.promise;
      phase('early revocation while replacement response is delayed');
      await browserExpect(page.locator('dialog')).toBeVisible();
      phase('recovery backdrop clicks cannot dismiss retained Settings or drafts');
      await page.mouse.click(10, 10);
      await browserExpect(page.locator('dialog')).toBeVisible();
      expect(await page.locator('[data-retained-settings]').count()).toBe(1);
      expect(await page.locator('[data-retained-ticket]').inputValue()).toBe('Source draft');
      await browserExpect(other.locator('dialog')).toBeVisible();
      release.resolve();
      await browserExpect(page.locator('dialog')).toHaveCount(0);
      expect(await page.locator('[data-retained-settings]').count()).toBe(1);
      await browserExpect(settings.getByRole('status')).toContainText('Username changed.');
      const replacement = await page.evaluate(() => localStorage.getItem('bearer-token'));
      await browserExpect.poll(() => peer.evaluate(() => localStorage.getItem('bearer-token'))).toBe(replacement);
      await browserExpect(peer.locator('dialog')).toHaveCount(0);
      expect(await peer.locator('[data-retained-ticket]').inputValue()).toBe('Sibling draft');

      phase('another profile signs back in without replacing the ticket editor');
      const overlay = other.locator('dialog');
      await overlay.getByLabel('Username', { exact: true }).fill('owner-after');
      await overlay.getByLabel('Password', { exact: true }).fill(credentials.password);
      await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
      await browserExpect(overlay).toHaveCount(0);
      expect(await other.locator('[data-retained-ticket]').inputValue()).toBe('Other-device draft');

      phase('password change in the retained settings dialog');
      await settings.locator('#password-current-password').fill(credentials.password);
      await settings.locator('#account-new-password').fill('synthetic-password-next');
      await settings.locator('#account-confirm-password').fill('synthetic-password-typo');
      await browserExpect(settings.getByRole('button', { name: 'Change password', exact: true })).toBeDisabled();
      await browserExpect(settings.locator('#account-confirm-password')).toHaveAttribute('aria-invalid', 'true');
      await settings.locator('#account-confirm-password').fill('synthetic-password-next');
      const reveal = settings.locator('button[aria-controls="account-new-password"]');
      await reveal.focus();
      await reveal.press('Enter');
      await browserExpect(settings.locator('#account-new-password')).toHaveAttribute('type', 'text');
      await browserExpect(settings.locator('#account-confirm-password')).toHaveAttribute('type', 'password');
      await browserExpect(reveal).toHaveAccessibleName('Hide password');
      await reveal.press('Space');
      await browserExpect(settings.locator('#account-new-password')).toHaveAttribute('type', 'password');
      expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({ path: join(artifacts, 'account-credentials-confirmation-desktop.png') });
      await settings.getByRole('button', { name: 'Change password', exact: true }).click();
      await browserExpect(settings.getByRole('status')).toContainText('Password changed.');
      expect(await page.locator('[data-retained-settings]').count()).toBe(1);
      expect(await page.locator('[data-retained-ticket]').inputValue()).toBe('Source draft');
      await browserExpect(peer.locator('dialog')).toHaveCount(0);
      await browserExpect(overlay).toBeVisible();
      await overlay.getByLabel('Password', { exact: true }).fill('synthetic-password-next');
      await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
      await browserExpect(overlay).toHaveCount(0);
      expect(await other.locator('[data-retained-ticket]').inputValue()).toBe('Other-device draft');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: join(artifacts, 'account-credentials-desktop.png') });
    } finally { await otherContext.close(); await peer.close(); }
  });
}, 120_000);

test('storage failure retains memory authorization and late HTTP rejection preserves sign-in after a lost response', async () => {
  await withChromiumFixture('account-credentials-uncertainty', async ({ page, integration }, phase) => {
    await page.goto(integration.garcon.baseUrl);
    const settings = await openPasswordSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const credentials = integration.garcon.credentials!;
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'bearer-token') throw new Error('Synthetic storage failure');
        return setItem.call(this, key, value);
      };
    });
    await settings.locator('#account-username').fill('memory-owner');
    await settings.locator('#username-current-password').fill(credentials.password);
    await settings.getByRole('button', { name: 'Change username', exact: true }).click();
    await browserExpect(settings.getByText('Signed in for this tab.', { exact: false })).toBeVisible();
    await browserExpect(settings.getByText('Username changed.', { exact: false })).toBeVisible();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    await page.screenshot({ path: join(artifacts, 'account-credentials-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    const heldSettings = Promise.withResolvers<Route>();
    await page.route('**/api/v1/app/settings', route => { heldSettings.resolve(route); });
    await openPasswordSettings(page);
    const oldRequest = await withTimeout(heldSettings.promise, 20_000, () => 'Missing settings refresh');
    await page.setViewportSize({ width: 390, height: 844 });
    let patches = 0;
    await page.route('**/api/v1/auth/password', async route => {
      patches++; await route.fetch(); await route.abort('failed');
    });
    await settings.locator('#password-current-password').fill(credentials.password);
    await settings.locator('#account-new-password').fill('synthetic-lost-response');
    await settings.locator('#account-confirm-password').fill('synthetic-lost-response');
    await settings.locator('button[aria-controls="account-confirm-password"]').click();
    await browserExpect(settings.locator('#account-confirm-password')).toHaveAttribute('type', 'text');
    await browserExpect(settings.locator('#account-new-password')).toHaveAttribute('type', 'password');
    expect(await settings.locator('#account-confirm-password')
      .evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: join(artifacts, 'account-credentials-confirmation-mobile.png') });
    await settings.getByRole('button', { name: 'Change password', exact: true }).click();
    phase('reauthentication after a committed mutation loses its reply');
    const overlay = page.locator('dialog');
    await browserExpect(overlay.getByLabel('Username', { exact: true })).toHaveValue('memory-owner');
    phase('late HTTP rejection cannot replace sign-in with an unrecoverable reconnect state');
    const rejected = await oldRequest.fetch();
    expect(rejected.status()).toBe(401);
    const delivered = page.waitForEvent('requestfinished', { predicate: request => request === oldRequest.request() });
    await oldRequest.fulfill({ response: rejected });
    await delivered;
    await page.unroute('**/api/v1/app/settings');
    await browserExpect(overlay.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await overlay.getByLabel('Password', { exact: true }).fill('synthetic-lost-response');
    await overlay.getByLabel('Password', { exact: true }).press('Enter');
    await browserExpect(overlay).toHaveCount(0);
    expect(patches).toBe(1);
    await browserExpect(settings).toBeVisible();
  });
}, 120_000);
