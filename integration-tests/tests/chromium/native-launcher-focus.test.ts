import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import type { ServerChoices } from '../../../native/src/launcher.js';
import { captureBrowserErrors } from '../../support/browser-errors.js';

test('native launcher retains focus only on eligible controls across delayed snapshots', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const scenarios = [
      { name: 'same attempt', selector: '#cancel-connection', expected: 'cancel-connection' },
      { name: 'disabled control', selector: '#retry-connection', expected: '' },
      { name: 'hidden control', selector: '#show-connection', expected: '' },
      { name: 'new attempt', selector: '#cancel-connection', expected: '' },
      { name: 'selection screen', selector: '#cancel-connection', expected: '' },
      { name: 'removed recent', selector: '#recent-servers button', expected: 'server-url' },
      { name: 'overlapping updates', selector: '#cancel-connection', expected: 'cancel-connection' },
      { name: 'moved focus', selector: '#cancel-connection', expected: 'connection-heading' },
    ];
    for (const scenario of scenarios) {
      const page = await browser.newPage();
      const errors: string[] = [];
      captureBrowserErrors(page.context(), errors);
      await page.route('http://native-launcher.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const assets: Record<string, [string, string]> = {
          '/': ['../../../native/src/index.html', 'text/html'],
          '/launcher.js': ['../../../native/src/launcher.js', 'text/javascript'],
          '/launcher.css': ['../../../native/src/launcher.css', 'text/css'],
          '/icon.png': ['../../../web/static/icons/icon-512.f6870a9c2dc5.png', 'image/png'],
        };
        const asset = assets[path];
        if (!asset) { await route.abort(); return; }
        await route.fulfill({ body: await readFile(new URL(asset[0], import.meta.url)), contentType: asset[1] });
      });
      await page.goto('http://native-launcher.test/');
      const result = await page.evaluate(async scenario => {
        const modulePath = '/launcher.js';
        const { mountLauncher } = await import(modulePath) as typeof import('../../../native/src/launcher.js');
        const snapshot: ServerChoices = {
          generation: 1, recents: [{ url: 'https://synthetic.test/', name: null }],
          lastUrl: 'https://synthetic.test/', currentUrl: null, canCancel: false,
          connection: {
            id: 1, server: 'Synthetic', url: 'https://synthetic.test/',
            message: null, ready: false, canRetry: true, canShow: true,
          },
        };
        if (scenario.name === 'removed recent') snapshot.connection = null;
        let hold = false;
        const replies: ((snapshot: ServerChoices) => void)[] = [];
        await mountLauncher(document, async () => hold
          ? new Promise<ServerChoices>(resolve => replies.push(resolve)) : snapshot);
        const control = document.querySelector<HTMLElement>(scenario.selector)!;
        control.focus();
        const hadFocus = document.activeElement === control;
        hold = true;
        window.dispatchEvent(new Event('garcon-chooser-update'));
        if (scenario.name === 'overlapping updates') window.dispatchEvent(new Event('garcon-chooser-update'));
        // A rendering turn makes Chromium actually blur disabled controls.
        const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await paint();
        const blurred = document.activeElement === document.body;
        const next = structuredClone(snapshot);
        if (scenario.name === 'new attempt') next.connection!.id++;
        if (scenario.name === 'disabled control') next.connection!.canRetry = false;
        if (scenario.name === 'hidden control') next.connection!.canShow = false;
        if (scenario.name === 'selection screen') next.connection = null;
        if (scenario.name === 'removed recent') next.recents = [];
        if (scenario.name === 'moved focus') {
          const heading = document.querySelector<HTMLElement>('#connection-heading')!;
          heading.tabIndex = -1;
          heading.focus();
        }
        replies.pop()!(next);
        await paint();
        for (const reply of replies) reply(snapshot);
        await paint();
        return { hadFocus, blurred, focused: document.activeElement?.id };
      }, scenario);
      expect(result.hadFocus, scenario.name).toBe(true);
      expect(result.blurred, scenario.name).toBe(true);
      expect(result.focused, scenario.name).toBe(scenario.expected);
      expect(errors).toEqual([]);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}, 30_000);
