import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import type { SnippetsMutationResponse, SnippetsSnapshot } from '../../../common/snippets.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

describe('snippet management search', () => {
  test('shares picker search behavior and keeps filtered snippets editable on desktop and mobile', async () => {
    await withChromiumFixture('snippet-management-search', async (fixture, markPhase) => {
      const { page, integration } = fixture;
      let snapshot = await integration.client.get<SnippetsSnapshot>('/api/v1/snippets');
      for (const snippet of [
        { shortName: 'audit', template: 'Review access permissions' },
        { shortName: 'review', template: 'Check changes for correctness' },
        { shortName: 'review_api', template: 'Inspect API contracts' },
        { shortName: 'summarize', template: 'Summarize recent changes' },
      ]) {
        const result = await integration.client.post<SnippetsMutationResponse>('/api/v1/snippets', {
          expectedRevision: snapshot.revision,
          snippet: { ...snippet, defaultArguments: '' },
        });
        snapshot = result.snapshot;
      }

      const cdp = await fixture.context.newCDPSession(page);
      for (const viewport of [
        { name: 'desktop', width: 1440, height: 900, touch: false },
        { name: 'mobile', width: 390, height: 844, touch: true },
      ]) {
        markPhase(`checking ${viewport.name} search and edit`);
        await cdp.send('Emulation.setTouchEmulationEnabled', {
          enabled: viewport.touch, maxTouchPoints: 1,
        });
        await page.setViewportSize(viewport);
        await page.goto(integration.garcon.baseUrl);
        await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
        const composer = page.getByPlaceholder('How can I help you today?');
        await composer.fill(';;');
        const palette = page.getByRole('dialog', { name: 'Insert Snippet' });
        const pickerSearch = palette.getByRole('combobox', { name: 'Search snippets' });
        await pickerSearch.fill('  REVIEW  ');
        await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 3);
        const pickerNames = await palette.getByRole('option').evaluateAll((options) =>
          options.map((option) => option.querySelector('.font-medium')?.textContent ?? ''),
        );
        expect(pickerNames).toEqual(['review', 'review_api', 'audit']);
        const pickerFont = await pickerSearch.evaluate((input) => getComputedStyle(input).fontSize);
        await palette.getByRole('button', { name: 'Edit snippets', exact: true }).click();

        const manager = page.getByRole('dialog', { name: 'Snippets', exact: true });
        const search = manager.getByRole('searchbox', { name: 'Search snippets' });
        await search.fill('  REVIEW  ');
        await page.waitForFunction(() => document.querySelectorAll('article').length === 3);
        expect(await manager.getByRole('heading', { level: 3 }).allTextContents()).toEqual(pickerNames);
        expect(await search.evaluate((input) => getComputedStyle(input).fontSize)).toBe(pickerFont);
        if (viewport.touch) expect(Number.parseFloat(pickerFont)).toBeGreaterThanOrEqual(16);
        const overflow = await manager.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        const screenshotDirectory = process.env.SNIPPET_SEARCH_SCREENSHOT_DIR;
        if (screenshotDirectory) {
          await mkdir(screenshotDirectory, { recursive: true });
          await page.screenshot({ path: `${screenshotDirectory}/${viewport.name}.png` });
        }

        await manager.getByRole('button', { name: 'Edit review', exact: true }).click();
        const form = page.getByRole('dialog', { name: 'Edit Snippet', exact: true });
        expect(await form.getByRole('textbox', { name: 'Short name' }).inputValue()).toBe('review');
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await search.inputValue()).toBe('  REVIEW  ');
        await search.fill('no-such-snippet');
        await manager.getByText('No snippets match your search.', { exact: true }).waitFor();
        expect(await manager.getByRole('button', { name: 'Add snippet', exact: true }).isEnabled()).toBe(true);
        await search.fill('');
        await page.waitForFunction(() => document.querySelectorAll('article').length === 4);
      }
      fixture.assertNoBrowserErrors();
    });
  }, 180_000);
});
