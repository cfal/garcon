import { expect, test } from 'bun:test';
import { parseDisplayWindowRequest, type DisplayWindowRequest } from '../../../common/transcript-display-contract.js';
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
    const reads: DisplayWindowRequest[] = [];
    fixture.page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/v1/chats/transcript-display/window') {
        const input = parseDisplayWindowRequest(JSON.parse(request.postData() ?? 'null'));
        if (input.anchor.kind === 'around') reads.push(input);
      }
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
    expect(reads[0]!.anchor).toEqual({ kind: 'around', ordinal: target.ordinal });
    expect(reads[0]!.transcriptViewId).toBe(target.transcriptViewId);
    fixture.assertNoBrowserErrors();
  });
});
