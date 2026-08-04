import { describe, expect, test } from 'bun:test';
import type {
  SnippetsMutationResponse,
  SnippetsSnapshot,
} from '../../../common/snippets.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const NEW_CHAT_COMPOSER =
  '[role="dialog"] textarea[placeholder="How can I help you today?"]';

describe('snippet palette focus', () => {
  test('preserves a short viewport and restores the caret after cancelling arguments', async () => {
    await withE2eFixture('snippet-palette-focus', async (fixture) => {
      const snapshot = await fixture.integration.client.get<SnippetsSnapshot>('/api/v1/snippets');
      await fixture.integration.client.post<SnippetsMutationResponse>('/api/v1/snippets', {
        expectedRevision: snapshot.revision,
        snippet: {
          shortName: 'review',
          template: 'Review {{arguments}}',
        },
      });

      const app = new SpaDriver(fixture.page, fixture.integration);
      await fixture.page.setViewport({ width: 844, height: 390, isMobile: true });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton('New Chat');
      await fixture.page.waitForSelector(NEW_CHAT_COMPOSER);
      await app.fill(
        '[role="dialog"] input[aria-label="Project Path"]',
        fixture.integration.dirs.project,
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
          previewTabIndex: preview?.tabIndex ?? -1,
          listHeight: list?.getBoundingClientRect().height ?? 0,
        };
      });
      expect(paletteLayout.previewTabIndex).toBe(0);
      expect(paletteLayout.listHeight).toBeGreaterThan(0);
      await fixture.page.evaluate(() => {
        const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (element) => element.textContent?.includes('review'),
        );
        if (!option) throw new Error('Missing review snippet option.');
        option.click();
      });

      await fixture.page.waitForFunction(
        () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
          (dialog) => dialog.textContent?.includes('Arguments for /snippet review'),
        ),
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
          (element) => element.textContent?.includes('Arguments for /snippet review'),
        );
        if (!dialog) throw new Error('Missing snippet arguments dialog.');
        dialog.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
      });

      await fixture.page.waitForFunction(
        (selector) => {
          const composer = document.querySelector<HTMLTextAreaElement>(selector);
          const argumentsOpen = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
            (dialog) => dialog.textContent?.includes('Arguments for /snippet review'),
          );
          return !argumentsOpen
            && document.activeElement === composer
            && composer?.value === ';;rev'
            && composer.selectionStart === 5
            && composer.selectionEnd === 5;
        },
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER,
      );

      const composer = await fixture.page.$eval(NEW_CHAT_COMPOSER, (element) => ({
        value: (element as HTMLTextAreaElement).value,
        selectionStart: (element as HTMLTextAreaElement).selectionStart,
        selectionEnd: (element as HTMLTextAreaElement).selectionEnd,
      }));
      expect(composer).toEqual({ value: ';;rev', selectionStart: 5, selectionEnd: 5 });
      fixture.assertNoBrowserErrors();
    });
  });
});
