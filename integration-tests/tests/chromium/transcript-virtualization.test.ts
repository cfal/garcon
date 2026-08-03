import { describe, expect, test } from 'bun:test';
import type { Page } from 'playwright';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const SIZER_SELECTOR = '[data-chat-virtual-sizer]';
const ITEM_SELECTOR = '[data-chat-virtual-item]';

interface ReadingAnchor {
  key: string;
  offset: number;
}

interface TranscriptGeometry {
  distanceFromEnd: number;
  itemCount: number;
  modelCount: number;
  overlaps: Array<{ previous: string; next: string; amount: number }>;
  horizontalOverflow: Array<{ key: string; left: number; right: number }>;
}

async function appendTurn(
  integration: IntegrationFixture,
  chatId: string,
  content: string,
): Promise<void> {
  const accepted = await integration.client.runDirectChat({
    chatId,
    content,
    agent: integration.directAgents.openAi,
  });
  const terminal = await integration.client.waitForTurnTerminal(chatId, accepted.turnId);
  expect(terminal.type).toBe('agent-run-finished');
}

async function seedTranscript(integration: IntegrationFixture, turnCount: number): Promise<string> {
  const chatId = integration.newChatId();
  const started = await integration.client.startDirectChat({
    chatId,
    content: 'chromium-virtual-turn-0',
    projectPath: integration.dirs.project,
    agent: integration.directAgents.openAi,
  });
  expect((await integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
    'agent-run-finished',
  );
  for (let index = 1; index < turnCount; index += 1) {
    await appendTurn(integration, chatId, `chromium-virtual-turn-${index}`);
  }
  return chatId;
}

async function waitForModelCount(page: Page, minimum: number): Promise<number> {
  await page.waitForFunction(
    ({ selector, minimumCount }) => {
      const sizer = document.querySelector<HTMLElement>(selector);
      return Number(sizer?.dataset.chatVirtualModelCount ?? 0) >= minimumCount;
    },
    { selector: SIZER_SELECTOR, minimumCount: minimum },
    { timeout: 20_000 },
  );
  return page
    .locator(SIZER_SELECTOR)
    .evaluate((sizer) => Number((sizer as HTMLElement).dataset.chatVirtualModelCount ?? 0));
}

async function waitForDistanceFromEnd(page: Page, maximum: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, maximumDistance }) => {
      const feed = document.querySelector<HTMLElement>(selector);
      return Boolean(
        feed && feed.scrollHeight - feed.clientHeight - feed.scrollTop <= maximumDistance,
      );
    },
    { selector: FEED_SELECTOR, maximumDistance: maximum },
    { timeout: 20_000 },
  );
}

async function waitForTranscriptReady(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).waitFor({ state: 'visible' });
  await page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor({ state: 'visible' });
}

async function surfaceIdentity(page: Page): Promise<string> {
  return page.locator(ITEM_SELECTOR).first().evaluate((item) => {
    const value = (item as HTMLElement).dataset.chatVirtualItem;
    if (!value) throw new Error('Virtual item key is missing.');
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
      throw new Error('Virtual item key does not contain a surface identity.');
    }
    return parsed[0];
  });
}

async function waitForSurfaceIdentityChange(page: Page, previous: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, priorIdentity }) =>
      [...document.querySelectorAll<HTMLElement>(selector)].some((item) => {
        const value = item.dataset.chatVirtualItem;
        if (!value) return false;
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0] !== priorIdentity;
        } catch {
          return false;
        }
      }),
    { selector: ITEM_SELECTOR, priorIdentity: previous },
    { timeout: 20_000 },
  );
}

async function scrollToPosition(
  page: Page,
  position: 'start' | 'middle' | 'end',
  signalIntent = true,
): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate(async (feedElement, target) => {
    const feed = feedElement as HTMLElement;
    if (target.signalIntent) {
      const deltaY = target.position === 'start' || target.position === 'middle' ? -600 : 600;
      feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY }));
    }
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const attempts = target.position === 'middle' ? 1 : 16;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
      feed.scrollTop =
        target.position === 'start' ? 0 : target.position === 'middle' ? maximum / 2 : maximum;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      await settle();
      await settle();
      if (target.position === 'middle') {
        let previous = feed.scrollTop;
        let stableFrames = 0;
        for (let frame = 0; frame < 16; frame += 1) {
          await settle();
          const current = feed.scrollTop;
          stableFrames = Math.abs(current - previous) <= 0.5 ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 4) return;
        }
        throw new Error('Transcript middle position did not settle.');
      }
      const distanceFromTarget =
        target.position === 'start'
          ? feed.scrollTop
          : Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop);
      if (distanceFromTarget <= 1) {
        for (let stableFrame = 0; stableFrame < 4; stableFrame += 1) await settle();
        const settledDistance =
          target.position === 'start'
            ? feed.scrollTop
            : Math.abs(feed.scrollHeight - feed.clientHeight - feed.scrollTop);
        if (settledDistance <= 1) return;
      }
    }
    throw new Error(`Transcript did not settle at its ${target.position} position.`);
  }, { position, signalIntent });
}

async function signalScrollIntent(page: Page, direction: 'earlier' | 'later'): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate((feedElement, requestedDirection) => {
    feedElement.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        deltaY: requestedDirection === 'earlier' ? -1 : 1,
      }),
    );
  }, direction);
}

async function readingAnchor(page: Page): Promise<ReadingAnchor> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, itemSelector) => {
    const feed = feedElement as HTMLElement;
    const viewport = feed.getBoundingClientRect();
    const candidates = [...feed.querySelectorAll<HTMLElement>(itemSelector)]
      .filter((item) => item.querySelector('[data-chat-row-id]'))
      .map((item) => ({ item, rect: item.getBoundingClientRect() }))
      .filter(({ rect }) => rect.bottom > viewport.top + 1 && rect.top < viewport.bottom - 1)
      .sort((left, right) => left.rect.top - right.rect.top);
    const anchor = candidates[0];
    const key = anchor?.item.dataset.chatVirtualItem;
    if (!anchor || !key) throw new Error('No visible transcript item is available as an anchor.');
    return { key, offset: anchor.rect.top - viewport.top };
  }, ITEM_SELECTOR);
}

async function anchorByKey(page: Page, key: string): Promise<ReadingAnchor> {
  await page.waitForFunction(
    ({ itemSelector, expectedKey }) =>
      [...document.querySelectorAll<HTMLElement>(itemSelector)].some(
        (candidate) => candidate.dataset.chatVirtualItem === expectedKey,
      ),
    { itemSelector: ITEM_SELECTOR, expectedKey: key },
    { timeout: 20_000 },
  );
  return page.locator(FEED_SELECTOR).evaluate(
    (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const item = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
        (candidate) => candidate.dataset.chatVirtualItem === input.key,
      );
      if (!item) throw new Error(`Reading anchor ${input.key} is not mounted.`);
      return {
        key: input.key,
        offset: item.getBoundingClientRect().top - feed.getBoundingClientRect().top,
      };
    },
    { itemSelector: ITEM_SELECTOR, key },
  );
}

async function transcriptGeometry(page: Page): Promise<TranscriptGeometry> {
  return page.locator(FEED_SELECTOR).evaluate(
    (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const viewport = feed.getBoundingClientRect();
      const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
      if (!sizer) throw new Error('Virtual transcript sizer is missing.');
      const items = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)]
        .map((item) => ({
          key: item.dataset.chatVirtualItem ?? '',
          rect: item.getBoundingClientRect(),
        }))
        .sort((left, right) => left.rect.top - right.rect.top);
      const overlaps: TranscriptGeometry['overlaps'] = [];
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1];
        const next = items[index];
        if (previous && next && next.rect.top < previous.rect.bottom - 1) {
          overlaps.push({
            previous: previous.key,
            next: next.key,
            amount: previous.rect.bottom - next.rect.top,
          });
        }
      }
      return {
        distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
        itemCount: items.length,
        modelCount: Number(sizer.dataset.chatVirtualModelCount ?? 0),
        overlaps,
        horizontalOverflow: items
          .filter(({ rect }) => rect.left < viewport.left - 1 || rect.right > viewport.right + 1)
          .map(({ key, rect }) => ({
            key,
            left: rect.left,
            right: rect.right,
          })),
      };
    },
    { itemSelector: ITEM_SELECTOR, sizerSelector: SIZER_SELECTOR },
  );
}

async function diagnostics(fixture: ChromiumFixture): Promise<unknown> {
  return {
    geometry: await transcriptGeometry(fixture.page).catch(() => null),
    mountedKeys: await fixture.page
      .locator(ITEM_SELECTOR)
      .evaluateAll((items) =>
        items.map((item) => (item as HTMLElement).dataset.chatVirtualItem ?? ''),
      )
      .catch(() => []),
  };
}

describe('Chromium transcript virtualization', () => {
  test('bounds mounted rows and preserves prepend, detached append, and pinned append geometry', async () => {
    await withChromiumFixture(
      'transcript-virtualization',
      async (fixture) => {
        const chatId = await seedTranscript(fixture.integration, 60);
        const response = await fixture.page.goto(
          `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
          { waitUntil: 'domcontentloaded' },
        );
        if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);

        await waitForTranscriptReady(fixture.page);
        const initialSurfaceIdentity = await surfaceIdentity(fixture.page);
        await appendTurn(fixture.integration, chatId, 'chromium-generation-prime');
        await fixture.page
          .locator(FEED_SELECTOR)
          .getByText('echo:chromium-generation-prime', { exact: true })
          .waitFor();
        await waitForSurfaceIdentityChange(fixture.page, initialSurfaceIdentity);
        await waitForTranscriptReady(fixture.page);
        const initialModelCount = await waitForModelCount(fixture.page, 50);
        await scrollToPosition(fixture.page, 'end');
        await waitForDistanceFromEnd(fixture.page, 1);
        await scrollToPosition(fixture.page, 'middle');
        await signalScrollIntent(fixture.page, 'later');
        await scrollToPosition(fixture.page, 'start', false);
        const loadEarlier = fixture.page.locator(
          '[data-transcript-page-boundary="earlier"] button',
        );
        await loadEarlier.waitFor({ state: 'visible' });
        const prependAnchor = await readingAnchor(fixture.page);
        await loadEarlier.click();
        await waitForModelCount(fixture.page, initialModelCount + 50);
        const restoredPrependAnchor = await anchorByKey(fixture.page, prependAnchor.key);
        expect(
          Math.abs(restoredPrependAnchor.offset - prependAnchor.offset),
        ).toBeLessThanOrEqual(1);

        const expandedGeometry = await transcriptGeometry(fixture.page);
        expect(expandedGeometry.modelCount).toBeGreaterThanOrEqual(100);
        expect(expandedGeometry.itemCount).toBeLessThan(60);
        expect(expandedGeometry.overlaps).toEqual([]);
        expect(expandedGeometry.horizontalOverflow).toEqual([]);

        await scrollToPosition(fixture.page, 'middle');
        const detachedAnchor = await readingAnchor(fixture.page);
        await appendTurn(fixture.integration, chatId, 'chromium-detached-append');
        await fixture.page
          .getByRole('status')
          .filter({ hasText: 'New response available' })
          .waitFor();
        const restoredDetachedAnchor = await anchorByKey(fixture.page, detachedAnchor.key);
        expect(
          Math.abs(restoredDetachedAnchor.offset - detachedAnchor.offset),
          JSON.stringify({ detachedAnchor, restoredDetachedAnchor }),
        ).toBeLessThanOrEqual(1);
        expect((await transcriptGeometry(fixture.page)).distanceFromEnd).toBeGreaterThan(1);

        await scrollToPosition(fixture.page, 'end');
        await appendTurn(fixture.integration, chatId, 'chromium-pinned-append');
        await fixture.page
          .locator(FEED_SELECTOR)
          .getByText('echo:chromium-pinned-append', { exact: true })
          .waitFor();
        await waitForDistanceFromEnd(fixture.page, 1);
        expect((await transcriptGeometry(fixture.page)).distanceFromEnd).toBeLessThanOrEqual(1);
        fixture.assertNoBrowserErrors();
      },
      diagnostics,
    );
  }, 120_000);
});
