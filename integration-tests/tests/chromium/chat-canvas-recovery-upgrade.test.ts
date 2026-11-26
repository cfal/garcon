import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { ChatCanvas } from '../../../common/chat-canvas.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';

const endpoint = '/api/v1/chat-canvases';

test('does not adopt legacy drafts on a same-tab upgrade and clears both formats on logout', async () => {
  await withChromiumFixture('canvas-recovery-upgrade', async ({ browser, integration, watchBrowserErrors }, markPhase) => {
    const { baseUrl, credentials } = integration.garcon;
    if (!credentials) throw new Error('Canvas upgrade fixture requires a configured account');
    const original = await integration.client.post<ChatCanvas>(endpoint, {
      id: 'original', content: { title: 'Saved original', nodes: [], connections: [] },
    });
    const own = await integration.client.post<ChatCanvas>(endpoint, {
      id: 'own', content: { title: 'Original revision', nodes: [], connections: [] },
    });
    await integration.client.put(endpoint, {
      id: own.id, expectedRevision: own.revision, content: { ...own.content, title: 'New server revision' },
    });
    const legacy = {
      ...original,
      content: {
        ...original.content,
        title: 'Synthetic legacy draft',
        nodes: [{ id: 'legacy-box', type: 'box', title: 'Synthetic legacy box', position: { x: 20, y: 30 } }],
      },
    } satisfies ChatCanvas;
    const entries = [
      ['chat-canvas-recovery-v1:original', JSON.stringify(legacy)],
      ['chat-canvas-recovery-v1:legacy-only', JSON.stringify({ ...legacy, id: 'legacy-only' })],
      ['chat-canvas-recovery-v1:viewer:user%3Aother-viewer:other', JSON.stringify({ ...legacy, id: 'other' })],
    ] as const;
    const ownEntry = [`chat-canvas-recovery-v1:viewer:${encodeURIComponent(`user:${credentials.username}`)}:own`,
      JSON.stringify({ ...own, content: { ...own.content, title: 'My draft' } })] as const;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    try {
      watchBrowserErrors(context);
      await context.addInitScript(seedLocalSettings, { allowDirectChats: true });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      const previousDocument = new URL('/canvas-before-upgrade', baseUrl).href;
      await page.route(previousDocument, route => route.fulfill({ contentType: 'text/html', body: '<title>Before upgrade</title>' }), { times: 1 });
      await page.goto(previousDocument);
      await page.evaluate(entries => {
        for (const [key, value] of entries) sessionStorage.setItem(key, value);
        sessionStorage.setItem('unrelated-tab', 'keep');
        localStorage.setItem('unrelated-app', 'keep');
      }, entries);
      await page.goto(`${baseUrl}/login`);
      await page.getByLabel('Username', { exact: true }).fill(credentials.username);
      await page.getByLabel('Password', { exact: true }).fill(credentials.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.locator('[data-workspace-window-current="true"] [data-workspace-window-titlebar]').waitFor();

      markPhase('opening and copying the saved canvas without adopting the legacy draft');
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, 'Open Canvas');
      const panel = page.locator('[data-canvas-panel]');
      const chooser = panel.getByLabel('Choose canvas');
      await chooser.selectOption(original.id);
      await browserExpect(chooser).toHaveValue(original.id);
      await browserExpect(chooser.locator('option[value="original"]')).toHaveText(original.content.title);
      await browserExpect(chooser.locator('option[value="legacy-only"], option[value="other"]')).toHaveCount(0);
      await browserExpect(panel.locator('.svelte-flow__node[data-id="legacy-box"]')).toHaveCount(0);
      await panel.locator('header').getByRole('button', { name: 'Save as copy', exact: true }).click();
      const copy = page.getByRole('dialog', { name: 'Save as copy', exact: true });
      await copy.getByRole('textbox').fill('Saved copy');
      await copy.getByRole('button', { name: 'Apply', exact: true }).click();
      await copy.waitFor({ state: 'hidden' });
      const copyId = await chooser.inputValue();
      expect(copyId).not.toBe(original.id);
      expect((await integration.client.get<ChatCanvas>(`${endpoint}?id=${copyId}`)).content)
        .toEqual({ ...original.content, title: 'Saved copy' });

      markPhase('recovering the current viewer draft and clearing local recovery on logout');
      await page.evaluate(([key, value]) => sessionStorage.setItem(key, value), ownEntry);
      await chooser.selectOption(own.id);
      await browserExpect(chooser).toHaveValue(own.id);
      await browserExpect(chooser.locator('option[value="own"]')).toHaveText('My draft');
      expect(await page.evaluate(entries => entries.every(([key, value]) => sessionStorage.getItem(key) === value), [...entries, ownEntry])).toBe(true);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('tab', { name: 'Authentication', exact: true }).click();
      await settings.getByRole('button', { name: 'Log out', exact: true }).click();
      await page.getByRole('dialog', { name: 'Log out of this browser?', exact: true })
        .getByRole('button', { name: 'Log out', exact: true }).click();
      await browserExpect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect(await page.evaluate(() => ({
        recovery: Object.keys(sessionStorage).filter(key => key.startsWith('chat-canvas-recovery-v1:')),
        unrelatedTab: sessionStorage.getItem('unrelated-tab'),
        unrelatedApp: localStorage.getItem('unrelated-app'),
      }))).toEqual({ recovery: [], unrelatedTab: 'keep', unrelatedApp: 'keep' });
    } finally {
      await context.close();
    }
  });
}, 120_000);
