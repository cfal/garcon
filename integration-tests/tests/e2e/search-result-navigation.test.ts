import { expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { createSearchNavigationTarget } from '../../support/search-navigation-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('search opens a cold chat at the original old matching row with a targeted page', async () => {
  await withE2eFixture('search-result-cold', async (fixture) => {
    const { target, marker } = await createSearchNavigationTarget(fixture.integration);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1440, 900);
    await app.open();
    await fixture.waitForSpaWebSocket();
    const reads: URL[] = [];
    fixture.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/chats/messages' && url.searchParams.has('beforeOrdinal'))
        reads.push(url);
    });
    await app.openChatSearch();
    await app.searchChats(marker);
    await app.waitForTranscriptSearchResult({ count: 1, snippet: marker });
    await fixture.page.waitForSelector('[data-slot="transcript-search-snippet"]');
    await fixture.page.evaluate(() => {
      const option = document.querySelector<HTMLElement>(
        '[data-slot="search-dialog-results"] [role="option"]',
      );
      if (!option) throw new Error('Missing search result');
      option.click();
    });
    await fixture.page.waitForSelector(
      `[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`,
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]!.searchParams.get('beforeOrdinal')).toBe(String(target.ordinal + 1));
    expect(reads[0]!.searchParams.get('transcriptViewId')).toBe(target.transcriptViewId);
    fixture.assertNoBrowserErrors();
  });
});
