import { describe, expect, test } from 'bun:test';
import type { SnippetsMutationResponse, SnippetsSnapshot } from '../../../common/snippets.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const NEW_CHAT_COMPOSER = '[role="dialog"] textarea[placeholder="How can I help you today?"]';

describe('snippet palette focus', () => {
  test('reviews defaults in a short mobile viewport and preserves exact focus intent', async () => {
    await withE2eFixture('snippet-palette-focus', async (fixture) => {
      const snapshot = await fixture.integration.client.get<SnippetsSnapshot>('/api/v1/snippets');
      await fixture.integration.client.post<SnippetsMutationResponse>('/api/v1/snippets', {
        expectedRevision: snapshot.revision,
        snippet: {
          shortName: 'review',
          template: 'Review {{arguments}}',
          defaultArguments: 'staged changes',
        },
      });

      const app = new SpaDriver(fixture.page, fixture.integration);
      await fixture.page.setViewport({
        width: 390,
        height: 844,
        isMobile: true,
      });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton('New Chat');
      await fixture.page.waitForSelector(NEW_CHAT_COMPOSER);
      await app.fill(
        '[role="dialog"] input[aria-label="Project Path"]',
        fixture.integration.dirs.project,
      );
      await fixture.page.evaluate(() => {
        const viewport = window.visualViewport;
        if (!viewport) throw new Error('Missing visual viewport.');
        Object.defineProperty(viewport, 'height', {
          configurable: true,
          value: 390,
        });
        viewport.dispatchEvent(new Event('resize'));
      });
      await fixture.page.waitForFunction(
        () => document.documentElement.style.getPropertyValue('--app-height') === '390px',
      );

      await fixture.page.$eval(NEW_CHAT_COMPOSER, (element) => {
        const composer = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          composer,
          ';;rev',
        );
        composer.focus();
        composer.setSelectionRange(5, 5);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await fixture.page.waitForFunction(
        () => document.activeElement?.getAttribute('role') === 'combobox',
        { timeout: 20_000 },
      );
      const paletteLayout = await fixture.page.evaluate(() => {
        const preview = document.querySelector<HTMLElement>(
          '[role="region"][aria-label="Template preview"]',
        );
        const list = document.querySelector<HTMLElement>('[role="listbox"]');
        return {
          previewVisible: Boolean(preview?.getClientRects().length),
          listHeight: list?.getBoundingClientRect().height ?? 0,
        };
      });
      expect(paletteLayout.previewVisible).toBe(false);
      expect(paletteLayout.listHeight).toBeGreaterThan(0);
      await fixture.page.evaluate(() => {
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (element) => element.textContent?.includes('review'),
        );
        if (!option) throw new Error('Missing review snippet option.');
        option.click();
      });

      await fixture.page.waitForFunction(
        (expected) => {
          const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
            (element) => element.textContent?.includes('Arguments for /snippet review'),
          );
          const textarea = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
            (element) => element.labels?.[0]?.textContent?.trim() === 'Arguments',
          );
          return (
            Boolean(dialog) &&
            document.activeElement === textarea &&
            textarea?.value === expected &&
            textarea.selectionStart === 0 &&
            textarea.selectionEnd === expected.length
          );
        },
        { timeout: 20_000 },
        'staged changes',
      );
      const argumentsField = await fixture.page.evaluate(() => {
        const textarea = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
          (element) => element.labels?.[0]?.textContent?.trim() === 'Arguments',
        );
        if (!textarea) throw new Error('Missing snippet arguments field.');
        return {
          focused: document.activeElement === textarea,
          value: textarea.value,
          selectionStart: textarea.selectionStart,
          selectionEnd: textarea.selectionEnd,
        };
      });
      expect(argumentsField).toEqual({
        focused: true,
        value: 'staged changes',
        selectionStart: 0,
        selectionEnd: 'staged changes'.length,
      });
      await fixture.page.evaluate(() => {
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
          (element) => element.textContent?.includes('Arguments for /snippet review'),
        );
        if (!dialog) throw new Error('Missing snippet arguments dialog.');
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      await fixture.page.waitForFunction(
        (selector) => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          const argumentsOpen = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
            (dialog) => dialog.textContent?.includes('Arguments for /snippet review'),
          );
          return (
            !argumentsOpen &&
            document.activeElement === composer &&
            composer?.value === ';;rev' &&
            composer.selectionStart === 5 &&
            composer.selectionEnd === 5
          );
        },
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER,
      );

      const composer = await fixture.page.$eval(NEW_CHAT_COMPOSER, (element) => ({
        value: (element as HTMLTextAreaElement).value,
        selectionStart: (element as HTMLTextAreaElement).selectionStart,
        selectionEnd: (element as HTMLTextAreaElement).selectionEnd,
      }));
      expect(composer).toEqual({
        value: ';;rev',
        selectionStart: 5,
        selectionEnd: 5,
      });

      await fixture.page.$eval(NEW_CHAT_COMPOSER, (element) => {
        const composer = element as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(composer, '');
        composer.setSelectionRange(0, 0);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await fixture.page.waitForFunction(
        (selector) => document.querySelector<HTMLTextAreaElement>(selector)?.value === '',
        {},
        NEW_CHAT_COMPOSER,
      );
      await fixture.page.$eval(NEW_CHAT_COMPOSER, (element) => {
        const composer = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          composer,
          ';;rev',
        );
        composer.setSelectionRange(5, 5);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await fixture.page.waitForFunction(
        () => document.activeElement?.getAttribute('role') === 'combobox',
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (element) => element.textContent?.includes('review'),
        );
        if (!option) throw new Error('Missing review snippet option.');
        option.click();
      });
      await fixture.page.waitForFunction(
        () =>
          document.activeElement instanceof HTMLTextAreaElement &&
          document.activeElement.labels?.[0]?.textContent?.trim() === 'Arguments',
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const clear = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent?.trim() === 'Clear',
        );
        if (!clear) throw new Error('Missing Clear button.');
        clear.click();
      });
      await fixture.page.waitForFunction(() => {
        const textarea = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
          (element) => element.labels?.[0]?.textContent?.trim() === 'Arguments',
        );
        return (
          textarea?.value === '' &&
          document.activeElement === textarea &&
          textarea.selectionStart === 0 &&
          textarea.selectionEnd === 0
        );
      });
      await fixture.page.evaluate(() => {
        const insert = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent?.trim() === 'Insert snippet',
        );
        if (!insert) throw new Error('Missing Insert snippet button.');
        insert.click();
      });
      await fixture.page.waitForFunction(
        (selector) => {
          const textarea = document.querySelector<HTMLTextAreaElement>(selector);
          return (
            textarea?.value === 'Review ' &&
            document.activeElement === textarea &&
            textarea.selectionStart === 'Review '.length &&
            textarea.selectionEnd === 'Review '.length
          );
        },
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER,
      );

      await fixture.page.$eval(NEW_CHAT_COMPOSER, (element) => {
        const composer = element as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
          composer,
          ';;rev',
        );
        composer.setSelectionRange(5, 5);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await fixture.page.waitForFunction(
        () => document.activeElement?.getAttribute('role') === 'combobox',
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (element) => element.textContent?.includes('review'),
        );
        if (!option) throw new Error('Missing review snippet option.');
        option.click();
      });
      await fixture.page.waitForFunction(() => {
        const textarea = [...document.querySelectorAll<HTMLTextAreaElement>('textarea')].find(
          (element) => element.labels?.[0]?.textContent?.trim() === 'Arguments',
        );
        return textarea?.value === 'staged changes' && document.activeElement === textarea;
      });
      await fixture.page.evaluate(() => {
        const insert = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
          (button) => button.textContent?.trim() === 'Insert snippet',
        );
        if (!insert) throw new Error('Missing Insert snippet button.');
        insert.click();
      });
      await fixture.page.waitForFunction(
        (selector) => {
          const textarea = document.querySelector<HTMLTextAreaElement>(selector);
          return (
            textarea?.value === 'Review staged changes' &&
            document.activeElement === textarea &&
            textarea.selectionStart === 'Review staged changes'.length &&
            textarea.selectionEnd === 'Review staged changes'.length
          );
        },
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER,
      );
      fixture.assertNoBrowserErrors();
    });
  });
});
