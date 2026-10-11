import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Locator } from 'playwright';
import type { SnippetsMutationResponse, SnippetsSnapshot } from '../../../common/snippets.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

async function settlePaletteLayout(palette: Locator): Promise<void> {
  // Allows layout-driven boundary events to fire before checking keyboard selection.
  await palette.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test('a parked mouse cannot replace snippet selection during loading, opening, filtering, or keyboard scrolling', async () => {
  await withChromiumFixture('snippet-palette-pointer', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client } = integration;
    let snapshot = await client.get<SnippetsSnapshot>('/api/v1/snippets');
    for (let index = 0; index < 16; index += 1) {
      const response = await client.post<SnippetsMutationResponse>('/api/v1/snippets', {
        expectedRevision: snapshot.revision,
        snippet: {
          shortName: `item-${String(index).padStart(2, '0')}`,
          template: `${index % 2 === 0 ? 'Review' : 'Summarize'} item ${index}`,
          defaultArguments: '',
        },
      });
      snapshot = response.snapshot;
    }

    const catalogRequested = new Deferred<void>();
    const releaseCatalog = new Deferred<void>();
    await page.route('**/api/v1/snippets', async (route) => {
      catalogRequested.resolve(undefined);
      await releaseCatalog.promise;
      await route.continue();
    });

    try {
      await page.goto(integration.garcon.baseUrl);
      await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
      const composer = page.getByPlaceholder('How can I help you today?');
      const newChat = page.getByRole('dialog').filter({ has: composer });
      await newChat.getByRole('textbox', { name: 'Project Path', exact: true }).fill(integration.dirs.project);
      const pathDismiss = page.locator('[data-slot="directory-browser-dismiss"]');
      if (await pathDismiss.isVisible()) await pathDismiss.click({ position: { x: 4, y: 4 } });

      const palette = page.getByRole('dialog', { name: 'Insert Snippet', exact: true });
      const search = palette.getByRole('combobox', { name: 'Search snippets' });
      const options = palette.getByRole('option');
      const assertActive = async (option: Locator) => {
        await settlePaletteLayout(palette);
        await browserExpect(option).toHaveAttribute('aria-selected', 'true');
        const optionId = await option.getAttribute('id') ?? '';
        await browserExpect(search).toHaveAttribute('aria-activedescendant', optionId);
      };
      const openFromKeyboard = async () => {
        await composer.fill('');
        await composer.pressSequentially(';;');
        await browserExpect(search).toBeFocused();
      };

      phase('checking delayed catalog arrival under a parked pointer');
      await openFromKeyboard();
      await catalogRequested.promise;
      await browserExpect(palette.getByText('Loading snippets...', { exact: true })).toBeVisible();
      await settlePaletteLayout(palette);
      const parkedPointer = { x: 720, y: 450 };
      await page.mouse.move(parkedPointer.x, parkedPointer.y);
      releaseCatalog.resolve(undefined);
      await browserExpect(options).toHaveCount(16);
      await assertActive(options.first());
      const optionIdUnderPointer = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.id,
        parkedPointer,
      );
      expect(optionIdUnderPointer).toBeTruthy();
      expect(optionIdUnderPointer).not.toBe(await options.first().getAttribute('id'));

      phase('checking keyboard opening with the mouse already over a non-first row');
      await search.press('Escape');
      await palette.waitFor({ state: 'detached' });
      await openFromKeyboard();
      await assertActive(options.first());

      phase('checking multi-result filtering and keyboard scrolling');
      await search.fill('Summarize');
      await browserExpect(options).toHaveCount(8);
      await assertActive(options.first());
      await search.press('End');
      await assertActive(options.last());
      await search.press('Home');
      await assertActive(options.first());
      await search.press('ArrowDown');
      await assertActive(options.nth(1));
      await search.press('Enter');
      await browserExpect(composer).toHaveValue('Summarize item 3');
      await browserExpect(composer).toBeFocused();

      phase('checking deliberate movement, keyboard takeover, and movement within the same row');
      await openFromKeyboard();
      await assertActive(options.first());
      const hovered = options.nth(2);
      const bounds = await hovered.boundingBox();
      if (!bounds) throw new Error('Missing snippet option bounds.');
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(point.x, point.y);
      await assertActive(hovered);
      await search.press('ArrowUp');
      await assertActive(options.nth(1));
      await page.mouse.move(point.x + 1, point.y);
      await assertActive(hovered);
      await search.press('Enter');
      await browserExpect(composer).toHaveValue('Review item 2');

      phase('checking reopen after hover and direct click selection');
      await openFromKeyboard();
      await assertActive(options.first());
      await options.nth(3).click();
      await browserExpect(composer).toHaveValue('Summarize item 3');
      await browserExpect(composer).toBeFocused();
      assertNoBrowserErrors();
    } finally {
      releaseCatalog.resolve(undefined);
    }
  });
}, 120_000);
