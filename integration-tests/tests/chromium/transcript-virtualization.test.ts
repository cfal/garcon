import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, Page } from 'playwright';
import type { ChatGenerationResetMessage, ChatMessagesMessage } from '../../../common/ws-events.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import {
  closeChromiumBrowser,
  launchChromiumBrowser,
  withChromiumFixture,
  type ChromiumFixture,
} from '../../support/chromium-fixture.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

const FEED_SELECTOR = '[data-chat-scroll-viewport]';
const SIZER_SELECTOR = '[data-chat-virtual-sizer]';
const ITEM_SELECTOR = '[data-chat-virtual-item]';

interface ReadingAnchor {
  key: string;
  offset: number;
}

interface ReadingAnchorFrameSample {
  frame: number;
  offset: number | null;
  scrollTop: number;
}

interface SelectionSnapshot {
  key: string;
  rowId: string;
  text: string;
  scrollTarget: 'start' | 'end';
}

interface TranscriptGeometry {
  distanceFromEnd: number;
  itemCount: number;
  transcriptItemCount: number;
  modelCount: number;
  overlaps: Array<{ previous: string; next: string; amount: number }>;
  horizontalOverflow: Array<{ key: string; left: number; right: number }>;
}

interface TranscriptLayoutSnapshot {
  anchor: ReadingAnchor;
  anchorTransform: string;
  feed: {
    top: number;
    height: number;
    scrollTop: number;
    scrollHeight: number;
  };
  sizer: {
    top: number;
    height: number;
    declaredHeight: string;
    scale: string | undefined;
  };
  workspace: {
    top: number;
    height: number;
    styleTop: string;
    styleHeight: string;
  } | null;
}

async function withDiagnosticTimeout<T>(
  description: string,
  operation: Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

async function seedTranscript(
  integration: IntegrationFixture,
  turnCount: number,
  promptPrefix = 'chromium-virtual-turn',
): Promise<string> {
  const chatId = integration.newChatId();
  const started = await integration.client.startDirectChat({
    chatId,
    content: `${promptPrefix}-0`,
    projectPath: integration.dirs.project,
    agent: integration.directAgents.openAi,
  });
  expect((await integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
    'agent-run-finished',
  );
  for (let index = 1; index < turnCount; index += 1) {
    await appendTurn(integration, chatId, `${promptPrefix}-${index}`);
  }
  return chatId;
}

async function selectSidebarChat(page: Page, chatId: string, marker: string): Promise<void> {
  await page.evaluate((expected) => {
    const summary = [
      ...document.querySelectorAll<HTMLElement>('[data-slot="sidebar-chat-summary"]'),
    ].find((candidate) => candidate.innerText.includes(expected));
    const button = summary?.closest('button');
    if (!button) throw new Error(`Missing sidebar chat containing: ${expected}`);
    button.click();
  }, marker);
  await page.waitForURL((url) => url.pathname === `/chat/${encodeURIComponent(chatId)}`);
  await waitForTranscriptReady(page);
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

async function waitForStableModelCount(page: Page, minimum: number): Promise<number> {
  await waitForModelCount(page, minimum);
  return page.locator(SIZER_SELECTOR).evaluate(async (sizerElement, minimumCount) => {
    const sizer = sizerElement as HTMLElement;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let previous = -1;
    let stableFrames = 0;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await frame();
      const current = Number(sizer.dataset.chatVirtualModelCount ?? 0);
      stableFrames = current >= minimumCount && current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 12) return current;
    }
    throw new Error('The staged transcript model did not settle.');
  }, minimum);
}

async function virtualDataRevision(page: Page): Promise<number> {
  return page
    .locator(SIZER_SELECTOR)
    .evaluate((sizer) => Number((sizer as HTMLElement).dataset.chatVirtualDataRevision ?? 0));
}

async function waitForVirtualDataRevisionAfter(page: Page, previous: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, previousRevision }) =>
      Number(document.querySelector<HTMLElement>(selector)?.dataset.chatVirtualDataRevision ?? 0) >
      previousRevision,
    { selector: SIZER_SELECTOR, previousRevision: previous },
    { timeout: 20_000 },
  );
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

async function waitForStablePinnedTranscriptLayout(page: Page, scenario = 'unnamed'): Promise<void> {
  await withDiagnosticTimeout(
    `the pinned transcript geometry to settle (${scenario})`,
    page.locator(FEED_SELECTOR).evaluate(
      async (feedElement, input) => {
        const feed = feedElement as HTMLElement;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        let previous:
          | {
              dataRevision: number;
              distanceFromEnd: number;
              itemCount: number;
              lastBottom: number;
              lastHeight: number;
              lastKey: string;
              modelCount: number;
              scrollHeight: number;
              scrollTop: number;
            }
          | null = null;
        let stableFrames = 0;
        let diagnostic: unknown = null;

        for (let attempt = 0; attempt < 90; attempt += 1) {
          await frame();
          const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
          const items = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)]
            .map((item) => ({
              index: Number(item.dataset.index),
              key: item.dataset.chatVirtualItem ?? '',
              rect: item.getBoundingClientRect(),
            }))
            .filter((item) => Number.isFinite(item.index))
            .sort((left, right) => left.index - right.index);
          const overlaps: Array<{ previous: string; next: string; amount: number }> = [];
          const discontinuities: Array<{ previous: string; next: string; delta: number }> = [];
          for (let index = 1; index < items.length; index += 1) {
            const prior = items[index - 1];
            const current = items[index];
            if (!prior || !current || current.index !== prior.index + 1) continue;
            const delta = current.rect.top - prior.rect.bottom;
            if (delta < -1) {
              overlaps.push({ previous: prior.key, next: current.key, amount: -delta });
            } else if (delta > 1) {
              discontinuities.push({ previous: prior.key, next: current.key, delta });
            }
          }
          const last = items.at(-1);
          const current = {
            dataRevision: Number(sizer?.dataset.chatVirtualDataRevision ?? 0),
            distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
            itemCount: items.length,
            lastBottom: last?.rect.bottom ?? Number.NaN,
            lastHeight: last?.rect.height ?? Number.NaN,
            lastKey: last?.key ?? '',
            modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
            scrollHeight: feed.scrollHeight,
            scrollTop: feed.scrollTop,
          };
          const ready =
            feed.getAttribute('aria-busy') === 'false' &&
            feed.dataset.chatPinnedToBottom === 'true' &&
            !feed.querySelector('[data-chat-layout-pending]') &&
            current.itemCount > 0 &&
            current.modelCount > 0 &&
            Math.abs(current.distanceFromEnd) <= 1 &&
            overlaps.length === 0 &&
            discontinuities.length === 0;
          const unchanged =
            previous !== null &&
            current.dataRevision === previous.dataRevision &&
            current.itemCount === previous.itemCount &&
            current.lastKey === previous.lastKey &&
            current.modelCount === previous.modelCount &&
            Math.abs(current.distanceFromEnd - previous.distanceFromEnd) <= 0.5 &&
            Math.abs(current.lastBottom - previous.lastBottom) <= 0.5 &&
            Math.abs(current.lastHeight - previous.lastHeight) <= 0.5 &&
            Math.abs(current.scrollHeight - previous.scrollHeight) <= 0.5 &&
            Math.abs(current.scrollTop - previous.scrollTop) <= 0.5;
          stableFrames = ready && unchanged ? stableFrames + 1 : 0;
          diagnostic = { current, discontinuities, overlaps, ready, stableFrames };
          previous = current;
          if (stableFrames >= 7) return;
        }
        throw new Error(
          `Pinned transcript geometry did not settle (${input.scenario}): ${JSON.stringify(diagnostic)}`,
        );
      },
      { itemSelector: ITEM_SELECTOR, sizerSelector: SIZER_SELECTOR, scenario },
    ),
  );
}

async function waitForTranscriptReady(page: Page): Promise<void> {
  await page.locator(FEED_SELECTOR).waitFor({ state: 'visible' });
  await page.locator(`${FEED_SELECTOR}[aria-busy="false"]`).waitFor({ state: 'visible' });
}

async function surfaceIdentity(page: Page): Promise<string> {
  return page
    .locator(ITEM_SELECTOR)
    .first()
    .evaluate((item) => {
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
          return (
            Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0] !== priorIdentity
          );
        } catch {
          return false;
        }
      }),
    { selector: ITEM_SELECTOR, priorIdentity: previous },
    { timeout: 20_000 },
  );
}

async function waitForSurfaceIdentity(page: Page, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, expectedIdentity }) => {
      const identities = [...document.querySelectorAll<HTMLElement>(selector)].flatMap((item) => {
        const value = item.dataset.chatVirtualItem;
        if (!value) return [];
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed[0]] : [];
        } catch {
          return [];
        }
      });
      return identities.length > 0 && identities.every((identity) => identity === expectedIdentity);
    },
    { selector: ITEM_SELECTOR, expectedIdentity: expected },
    { timeout: 20_000 },
  );
}

async function synchronizeNativeTranscriptGeneration(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  // Forces native reconciliation before geometry samples a generation-scoped row key.
  const liveTranscript = await fixture.integration.client.getMessages(chatId, { limit: 200 });
  expect(liveTranscript.hasMore).toBe(false);
  const finalTranscript = await fixture.integration.client.reloadChat(chatId);
  expect(finalTranscript.hasMore).toBe(false);
  expect(finalTranscript.lastSeq).toBe(liveTranscript.lastSeq);
  await waitForSurfaceIdentity(fixture.page, `${chatId}:${finalTranscript.generationId}`);
  await waitForTranscriptReady(fixture.page);
}

async function scrollToPosition(
  page: Page,
  position: 'start' | 'middle' | 'end',
  signalIntent = true,
): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate(
    async (feedElement, target) => {
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
    },
    { position, signalIntent },
  );
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

async function transcriptBoundaryIntersectsViewport(
  page: Page,
  direction: 'earlier' | 'later',
): Promise<boolean> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, requestedDirection) => {
    const boundary = feedElement.querySelector<HTMLElement>(
      `[data-transcript-page-boundary="${requestedDirection}"]`,
    );
    if (!boundary) return false;
    const viewportRect = feedElement.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    return boundaryRect.bottom > viewportRect.top && boundaryRect.top < viewportRect.bottom;
  }, direction);
}

async function selectVisibleMessageText(page: Page): Promise<SelectionSnapshot> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const feed = feedElement as HTMLElement;
    const viewport = feed.getBoundingClientRect();
    const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (
        rect.top >= viewport.top && rect.bottom <= viewport.bottom && candidate.textContent?.trim()
      );
    });
    if (!row) throw new Error('No fully visible transcript row was available for selection.');
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let textNode: Text | null = null;
    while (walker.nextNode()) {
      const candidate = walker.currentNode;
      if (candidate instanceof Text && candidate.data.trim().length >= 8) {
        textNode = candidate;
        break;
      }
    }
    if (!textNode) throw new Error('The selected transcript row had no usable text node.');
    const start = textNode.data.search(/\S/);
    const end = Math.min(textNode.length, start + 12);
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const selection = document.getSelection();
    if (!selection) throw new Error('The browser selection API is unavailable.');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const wrapper = row.closest<HTMLElement>('[data-chat-virtual-item]');
    const key = wrapper?.dataset.chatVirtualItem;
    const rowId = row.dataset.chatRowId;
    if (!key || !rowId) throw new Error('The selected row is missing its virtual identity.');
    const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
    return {
      key,
      rowId,
      text: selection.toString(),
      scrollTarget: feed.scrollTop < maximum / 2 ? 'end' : 'start',
    };
  });
}

async function releaseBrowserSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function verifyDetachedNearEndGrowth(page: Page): Promise<void> {
  await signalScrollIntent(page, 'earlier');
  await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 80);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();
    await settle();
    feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 12);
    feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    await settle();
    await settle();
  });
  await page.waitForFunction(
    (selector) =>
      document.querySelector<HTMLElement>(selector)?.dataset.chatPinnedToBottom === 'false',
    FEED_SELECTOR,
    { timeout: 20_000 },
  );
  const growth = await page.locator(FEED_SELECTOR).evaluate(async (feedElement, itemSelector) => {
    const feed = feedElement as HTMLElement;
    const items = [...feed.querySelectorAll<HTMLElement>(itemSelector)].filter((item) =>
      item.querySelector('[data-chat-row-id]'),
    );
    const lastItem = items.at(-1);
    if (!lastItem) throw new Error('Detached growth target is missing.');
    const viewportRect = feed.getBoundingClientRect();
    const before = {
      scrollTop: feed.scrollTop,
      distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      virtualHeight:
        feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.getBoundingClientRect()
          .height ?? null,
      itemTop: lastItem.getBoundingClientRect().top - viewportRect.top,
      itemBottom: lastItem.getBoundingClientRect().bottom - viewportRect.top,
      itemHeight: lastItem.getBoundingClientRect().height,
    };
    lastItem.style.paddingBottom = '160px';
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const after = {
      scrollTop: feed.scrollTop,
      distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
      scrollHeight: feed.scrollHeight,
      clientHeight: feed.clientHeight,
      virtualHeight:
        feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]')?.getBoundingClientRect()
          .height ?? null,
      itemTop: lastItem.getBoundingClientRect().top - viewportRect.top,
      itemBottom: lastItem.getBoundingClientRect().bottom - viewportRect.top,
      itemHeight: lastItem.getBoundingClientRect().height,
    };
    lastItem.style.paddingBottom = '';
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return {
      before,
      after,
      movement: Math.abs(after.scrollTop - before.scrollTop),
    };
  }, ITEM_SELECTOR);
  expect(
    growth.after.itemHeight - growth.before.itemHeight,
    JSON.stringify(growth, null, 2),
  ).toBeGreaterThan(100);
  expect(
    growth.after.scrollHeight - growth.before.scrollHeight,
    JSON.stringify(growth, null, 2),
  ).toBeGreaterThan(100);
  expect(
    (growth.after.virtualHeight ?? 0) - (growth.before.virtualHeight ?? 0),
    JSON.stringify(growth, null, 2),
  ).toBeGreaterThan(100);
  expect(growth.movement, JSON.stringify(growth, null, 2)).toBeLessThanOrEqual(1);
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

async function startReadingAnchorFrameSampler(page: Page, anchor: ReadingAnchor): Promise<void> {
  await page.locator(FEED_SELECTOR).evaluate(
    async (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const browserGlobal = globalThis as typeof globalThis & {
        __chatReadingAnchorSampler?: {
          active: boolean;
          frame: number;
          key: string;
          samples: ReadingAnchorFrameSample[];
        };
      };
      const sampler = {
        active: true,
        frame: 0,
        key: input.key,
        samples: [] as ReadingAnchorFrameSample[],
      };
      browserGlobal.__chatReadingAnchorSampler = sampler;
      const sample = () => {
        if (!sampler.active) return;
        const viewport = feed.getBoundingClientRect();
        const item = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
          (candidate) => candidate.dataset.chatVirtualItem === sampler.key,
        );
        sampler.samples.push({
          frame: sampler.frame,
          offset: item ? item.getBoundingClientRect().top - viewport.top : null,
          scrollTop: feed.scrollTop,
        });
        sampler.frame += 1;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    },
    { itemSelector: ITEM_SELECTOR, key: anchor.key },
  );
}

async function finishReadingAnchorFrameSampler(page: Page): Promise<ReadingAnchorFrameSample[]> {
  return page.evaluate(async () => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatReadingAnchorSampler?: {
        active: boolean;
        samples: ReadingAnchorFrameSample[];
      };
    };
    const sampler = browserGlobal.__chatReadingAnchorSampler;
    if (!sampler) throw new Error('The reading-anchor frame sampler is missing.');
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    sampler.active = false;
    delete browserGlobal.__chatReadingAnchorSampler;
    return sampler.samples;
  });
}

async function anchorByKey(
  page: Page,
  key: string,
  context?: Record<string, unknown>,
): Promise<ReadingAnchor> {
  try {
    await page.waitForFunction(
      ({ itemSelector, expectedKey }) =>
        [...document.querySelectorAll<HTMLElement>(itemSelector)].some(
          (candidate) => candidate.dataset.chatVirtualItem === expectedKey,
        ),
      { itemSelector: ITEM_SELECTOR, expectedKey: key },
      { timeout: 20_000 },
    );
  } catch (error) {
    const expectedIdentity = (() => {
      try {
        const parsed = JSON.parse(key);
        return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : null;
      } catch {
        return null;
      }
    })();
    const current = await page
      .locator(FEED_SELECTOR)
      .evaluate((feedElement, input) => {
        const feed = feedElement as HTMLElement;
        const mountedKeys = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].flatMap(
          (item) => item.dataset.chatVirtualItem ?? [],
        );
        const mountedIdentities = [
          ...new Set(
            mountedKeys.flatMap((mountedKey) => {
              try {
                const parsed = JSON.parse(mountedKey);
                return Array.isArray(parsed) && typeof parsed[0] === 'string' ? [parsed[0]] : [];
              } catch {
                return [];
              }
            }),
          ),
        ];
        const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
        return {
          mountedIdentities,
          mountedKeys,
          scrollTop: feed.scrollTop,
          maximumScrollTop: Math.max(0, feed.scrollHeight - feed.clientHeight),
          distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
          pinned: feed.dataset.chatPinnedToBottom === 'true',
          userScrolledUp: feed.dataset.chatUserScrolledUp === 'true',
          modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
          dataRevision: Number(sizer?.dataset.chatVirtualDataRevision ?? 0),
          scale: sizer?.dataset.chatTranscriptScale,
        };
      }, { itemSelector: ITEM_SELECTOR, sizerSelector: SIZER_SELECTOR })
      .catch(() => null);
    throw new Error(
      `Timed out waiting for the strict reading anchor:\n${JSON.stringify(
        { expectedKey: key, expectedIdentity, context, current },
        null,
        2,
      )}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return page.locator(FEED_SELECTOR).evaluate(
    async (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      let previousOffset: number | null = null;
      let stableFrames = 0;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const item = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
          (candidate) => candidate.dataset.chatVirtualItem === input.key,
        );
        if (!item) throw new Error(`Reading anchor ${input.key} became unmounted.`);
        const offset = item.getBoundingClientRect().top - feed.getBoundingClientRect().top;
        stableFrames =
          previousOffset !== null && Math.abs(offset - previousOffset) <= 0.5
            ? stableFrames + 1
            : 0;
        previousOffset = offset;
        if (stableFrames >= 3) return { key: input.key, offset };
      }
      throw new Error(`Reading anchor ${input.key} did not settle.`);
    },
    { itemSelector: ITEM_SELECTOR, key },
  );
}

async function transcriptLayoutSnapshot(
  page: Page,
  key: string,
): Promise<TranscriptLayoutSnapshot> {
  return page.locator(FEED_SELECTOR).evaluate(
    (feedElement, input) => {
      const feed = feedElement as HTMLElement;
      const anchor = [...feed.querySelectorAll<HTMLElement>(input.itemSelector)].find(
        (candidate) => candidate.dataset.chatVirtualItem === input.key,
      );
      const sizer = feed.querySelector<HTMLElement>(input.sizerSelector);
      if (!anchor || !sizer) throw new Error('Transcript layout snapshot is incomplete.');
      const feedRect = feed.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const sizerRect = sizer.getBoundingClientRect();
      const workspace = feed.closest<HTMLElement>('[data-conversation-workspace-layer]');
      const workspaceRect = workspace?.getBoundingClientRect();
      return {
        anchor: { key: input.key, offset: anchorRect.top - feedRect.top },
        anchorTransform: anchor.style.transform,
        feed: {
          top: feedRect.top,
          height: feedRect.height,
          scrollTop: feed.scrollTop,
          scrollHeight: feed.scrollHeight,
        },
        sizer: {
          top: sizerRect.top,
          height: sizerRect.height,
          declaredHeight: sizer.style.height,
          scale: sizer.dataset.chatTranscriptScale,
        },
        workspace: workspaceRect
          ? {
              top: workspaceRect.top,
              height: workspaceRect.height,
              styleTop: workspace?.style.top ?? '',
              styleHeight: workspace?.style.height ?? '',
            }
          : null,
      };
    },
    { itemSelector: ITEM_SELECTOR, key, sizerSelector: SIZER_SELECTOR },
  );
}

async function waitForRowCentered(page: Page, rowId: string, tolerance = 2): Promise<void> {
  try {
    await page.waitForFunction(
      ({ feedSelector, expectedRowId, maximumDelta }) => {
        const feed = document.querySelector<HTMLElement>(feedSelector);
        const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
          (candidate) => candidate.dataset.chatRowId === expectedRowId,
        );
        if (!feed || !row) return false;
        const feedRect = feed.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const delta = rowRect.top + rowRect.height / 2 - (feedRect.top + feedRect.height / 2);
        return Math.abs(delta) <= maximumDelta;
      },
      {
        feedSelector: FEED_SELECTOR,
        expectedRowId: rowId,
        maximumDelta: tolerance,
      },
      { timeout: 20_000 },
    );
  } catch (error) {
    const geometry = await page.locator(FEED_SELECTOR).evaluate((feedElement, expectedRowId) => {
      const feed = feedElement as HTMLElement;
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      const feedRect = feed.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      return {
        rowMounted: Boolean(row),
        scrollTop: feed.scrollTop,
        distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
        feedHeight: feedRect.height,
        rowTop: rowRect ? rowRect.top - feedRect.top : null,
        rowHeight: rowRect?.height ?? null,
        targetRowId: expectedRowId,
        mountedRowIds: [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].map(
          (candidate) => candidate.dataset.chatRowId,
        ),
      };
    }, rowId);
    throw new Error(`Target row did not center: ${JSON.stringify(geometry)}`, {
      cause: error,
    });
  }
  await withDiagnosticTimeout(
    `centered target ${rowId} to settle`,
    page.locator(FEED_SELECTOR).evaluate(
      async (feedElement, input) => {
        const feed = feedElement as HTMLElement;
        let previous: { top: number; height: number } | null = null;
        let stableFrames = 0;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
            (candidate) => candidate.dataset.chatRowId === input.rowId,
          );
          if (!row) throw new Error(`Centered target ${input.rowId} became unmounted.`);
          const feedRect = feed.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const current = {
            top: rowRect.top - feedRect.top,
            height: rowRect.height,
          };
          const delta = current.top + current.height / 2 - feedRect.height / 2;
          if (Math.abs(delta) > input.tolerance) {
            stableFrames = 0;
          } else if (
            previous &&
            Math.abs(previous.top - current.top) <= 0.5 &&
            Math.abs(previous.height - current.height) <= 0.5
          ) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
          }
          previous = current;
          if (stableFrames >= 2) return;
        }
        throw new Error(`Centered target ${input.rowId} did not settle.`);
      },
      { rowId, tolerance },
    ),
  );
}

async function activeMainSurfaceLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.querySelector<HTMLElement>(
      '[data-floating-workspace-toolbar] [role="tab"][aria-selected="true"]',
    );
    const label = active?.getAttribute('aria-label') || active?.textContent?.trim();
    if (!label) throw new Error('Active main workspace tab is missing.');
    return label;
  });
}

async function openMainWorkspaceActions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-floating-workspace-toolbar] [data-workspace-taskbar-end] [data-slot="dropdown-menu-trigger"]',
    );
    if (!trigger) throw new Error('Main workspace menu is missing.');
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  });
}

async function clickMenuItem(page: Page, name: string): Promise<void> {
  await page.getByRole('menuitem', { name, exact: true }).click();
}

async function selectMainWorkspaceSurface(page: Page, name: string): Promise<void> {
  await page
    .locator('[data-floating-workspace-toolbar] [data-workspace-taskbar]')
    .getByRole('tab', { name, exact: true })
    .click();
}

async function selectMainWorkspaceSurfaceProgrammatically(page: Page, name: string): Promise<void> {
  await page
    .locator('[data-floating-workspace-toolbar] [data-workspace-taskbar]')
    .getByRole('tab', { name, exact: true })
    .evaluate((tab) => (tab as HTMLElement).click());
}

async function waitForTranscriptScale(page: Page, scale: number): Promise<void> {
  await page
    .locator(`${SIZER_SELECTOR}[data-chat-transcript-scale="${scale}"]`)
    .waitFor({ state: 'visible' });
  await page.locator(FEED_SELECTOR).evaluate(async () => {
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

async function addSidebarChatToSplit(page: Page, chatId: string): Promise<void> {
  const source = page.locator(`[data-sidebar-virtual-row="${chatId}"]`);
  await source.waitFor({ state: 'visible' });
  const previousPaneCount = await page.locator('[data-pane-id]').count();
  const targetPane = page.locator('[data-pane-id]').first();
  const targetRect = await targetPane.boundingBox();
  if (!targetRect) throw new Error('The split target pane has no browser geometry.');

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent('dragstart', { dataTransfer });
    const dropLayer = page.locator('[data-split-drag-layer]');
    await dropLayer.waitFor({ state: 'visible' });
    const point = {
      clientX: targetRect.x + targetRect.width - 8,
      clientY: targetRect.y + targetRect.height / 2,
      dataTransfer,
    };
    await dropLayer.dispatchEvent('dragover', point);
    await dropLayer.dispatchEvent('drop', point);
    await source.dispatchEvent('dragend', { dataTransfer });
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-pane-id]').length === expected,
      previousPaneCount + 1,
    );
  } finally {
    await dataTransfer.dispose();
  }
}

async function userMessageNavigatorRowIdContaining(page: Page, text: string): Promise<string> {
  const hasTarget = await page.evaluate(
    (expected) =>
      [...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]')].some(
        (candidate) => candidate.textContent?.includes(expected),
      ),
    text,
  );
  if (!hasTarget) {
    await page.locator('[data-user-message-navigator-list]').evaluate((listElement) => {
      const list = listElement as HTMLElement;
      list.scrollTop = list.scrollHeight;
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForFunction(
      (expected) =>
        [...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]')].some(
          (candidate) => candidate.textContent?.includes(expected),
        ),
      text,
      { timeout: 20_000 },
    );
  }
  return page.evaluate((expected) => {
    const row = [
      ...document.querySelectorAll<HTMLElement>('[data-user-message-navigator-row]'),
    ].find((candidate) => candidate.textContent?.includes(expected));
    const rowId = row?.dataset.userMessageNavigatorRow;
    if (!rowId) throw new Error(`Missing user-message navigator row containing: ${expected}`);
    return rowId;
  }, text);
}

async function clickUserMessageNavigatorRowContaining(page: Page, text: string): Promise<void> {
  await page.evaluate((expected) => {
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-user-message-navigator-row]'),
    ].find((candidate) => candidate.textContent?.includes(expected));
    if (!row) throw new Error(`Missing user-message navigator row containing: ${expected}`);
    row.click();
  }, text);
}

async function viewportPolicy(page: Page): Promise<{ pinned: boolean; userScrolledUp: boolean }> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const feed = feedElement as HTMLElement;
    return {
      pinned: feed.dataset.chatPinnedToBottom === 'true',
      userScrolledUp: feed.dataset.chatUserScrolledUp === 'true',
    };
  });
}

async function selectAndVerifyEdgeNavigatorTarget(
  page: Page,
  marker: string,
  edge: 'start' | 'end',
): Promise<void> {
  await openMainWorkspaceActions(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(
    (input) => {
      const feed = document.querySelector<HTMLElement>(input.feedSelector);
      if (!feed) return false;
      const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === input.rowId,
      );
      const atEdge =
        input.edge === 'start'
          ? feed.scrollTop <= 1
          : feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 1;
      return Boolean(row && atEdge);
    },
    { feedSelector: FEED_SELECTOR, rowId, edge },
    { timeout: 20_000 },
  );
}

async function installDelayedTargetGrowth(page: Page, rowId: string): Promise<void> {
  await page.evaluate((expectedRowId) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatDelayedTargetGrowthFrame?: number;
      __stopDelayedTargetGrowth?: () => void;
    };
    browserGlobal.__stopDelayedTargetGrowth?.();
    let cancelled = false;
    let observer: MutationObserver | null = null;
    let growingRow: HTMLElement | null = null;
    browserGlobal.__chatDelayedTargetGrowthFrame = 0;
    browserGlobal.__stopDelayedTargetGrowth = () => {
      cancelled = true;
      observer?.disconnect();
      growingRow?.style.removeProperty('padding-bottom');
      delete browserGlobal.__chatDelayedTargetGrowthFrame;
    };
    const growTarget = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      if (!row) return false;
      growingRow = row;
      let frame = 0;
      const grow = () => {
        if (cancelled || frame >= 60 || !row.isConnected) return;
        frame += 1;
        browserGlobal.__chatDelayedTargetGrowthFrame = frame;
        row.style.paddingBottom = `${frame * 40}px`;
        requestAnimationFrame(grow);
      };
      requestAnimationFrame(grow);
      return true;
    };
    if (growTarget()) return;
    observer = new MutationObserver(() => {
      if (!growTarget()) return;
      observer?.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, rowId);
}

async function installHeldTargetCompletion(page: Page, rowId: string): Promise<void> {
  await page.evaluate((expectedRowId) => {
    const browserGlobal = globalThis as typeof globalThis & {
      __completeHeldChatTarget?: () => void;
    };
    const holdTarget = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      if (!row) return false;
      row.dataset.chatLayoutPending = 'true';
      browserGlobal.__completeHeldChatTarget = () => {
        row.removeAttribute('data-chat-layout-pending');
        delete browserGlobal.__completeHeldChatTarget;
      };
      return true;
    };
    if (holdTarget()) return;
    const observer = new MutationObserver(() => {
      if (!holdTarget()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, rowId);
}

async function selectNavigatorTargetDuringAppend(
  fixture: ChromiumFixture,
  chatId: string,
  marker: string,
): Promise<void> {
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Jump to user message');
  await fixture.page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(fixture.page, marker);
  const appendedContent = 'chromium-target-concurrent-append';
  const heldCompletion = fixture.integration.fakeProviders.openAi.holdNext({
    lastUserText: appendedContent,
  });
  await installHeldTargetCompletion(fixture.page, rowId);
  await clickUserMessageNavigatorRowContaining(fixture.page, marker);
  await fixture.page.waitForFunction(
    (expectedRowId) =>
      [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].some(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      ),
    rowId,
    { timeout: 20_000 },
  );
  const dataRevision = await virtualDataRevision(fixture.page);

  let turnId: string | null = null;
  try {
    const accepted = await fixture.integration.client.runDirectChat({
      chatId,
      content: appendedContent,
      agent: fixture.integration.directAgents.openAi,
    });
    turnId = accepted.turnId ?? null;
    await withDiagnosticTimeout('the concurrent append request', heldCompletion.received);
    await waitForVirtualDataRevisionAfter(fixture.page, dataRevision);
    expect(
      await fixture.page
        .locator(`[data-chat-row-id="${rowId}"]`)
        .getAttribute('data-chat-layout-pending'),
    ).toBe('true');
    expect(
      await fixture.page.locator(FEED_SELECTOR).getAttribute('data-chat-pinned-to-bottom'),
    ).toBe('false');
    const detachedGeometry = await fixture.page.locator(FEED_SELECTOR).evaluate((feed) => ({
      distanceFromEnd: feed.scrollHeight - feed.clientHeight - feed.scrollTop,
      viewportHeight: feed.clientHeight,
    }));
    expect(detachedGeometry.distanceFromEnd).toBeGreaterThan(detachedGeometry.viewportHeight);
    await fixture.page.evaluate(() => {
      const browserGlobal = globalThis as typeof globalThis & {
        __completeHeldChatTarget?: () => void;
      };
      browserGlobal.__completeHeldChatTarget?.();
    });

    await waitForRowCentered(fixture.page, rowId);
    await fixture.page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  } finally {
    heldCompletion.releaseEcho();
  }
  if (turnId === null) throw new Error('Concurrent append turn was not accepted.');
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, turnId)).type).toBe(
    'agent-run-finished',
  );
  await waitForRowCentered(fixture.page, rowId);
}

async function installDelayedTargetCompletion(page: Page, rowId: string): Promise<void> {
  await page.evaluate((expectedRowId) => {
    const completeTarget = (): boolean => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      );
      if (!row) return false;
      row.dataset.chatLayoutPending = 'true';
      let frame = 0;
      const complete = () => {
        if (!row.isConnected) return;
        frame += 1;
        if (frame === 12) row.style.paddingBottom = '600px';
        if (frame >= 16) {
          row.removeAttribute('data-chat-layout-pending');
          return;
        }
        requestAnimationFrame(complete);
      };
      requestAnimationFrame(complete);
      return true;
    };
    if (completeTarget()) return;
    const observer = new MutationObserver(() => {
      if (!completeTarget()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, rowId);
}

async function selectAndVerifyNavigatorTarget(page: Page, marker: string): Promise<void> {
  await openMainWorkspaceActions(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  await waitForRowCentered(page, rowId);
}

async function selectAndVerifyDelayedNavigatorTarget(page: Page, marker: string): Promise<void> {
  await openMainWorkspaceActions(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await installDelayedTargetCompletion(page, rowId);
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
  await waitForRowCentered(page, rowId);
}

async function interruptNavigatorJump(page: Page, marker: string): Promise<void> {
  await openMainWorkspaceActions(page);
  await clickMenuItem(page, 'Jump to user message');
  await page.getByText('User messages', { exact: true }).waitFor();
  const rowId = await userMessageNavigatorRowIdContaining(page, marker);
  await installDelayedTargetGrowth(page, rowId);
  await page.locator(FEED_SELECTOR).evaluate((feedElement) => {
    const feed = feedElement as HTMLElement;
    const browserGlobal = globalThis as typeof globalThis & {
      __chatProgrammaticScrollWrites?: number[];
      __restoreChatScrollTo?: () => void;
    };
    browserGlobal.__chatProgrammaticScrollWrites = [];
    const originalScrollTo = feed.scrollTo.bind(feed);
    browserGlobal.__restoreChatScrollTo = () => {
      feed.scrollTo = originalScrollTo;
    };
    feed.scrollTo = ((options: ScrollToOptions | number, y?: number) => {
      const top =
        typeof options === 'number' ? (y ?? feed.scrollTop) : (options.top ?? feed.scrollTop);
      browserGlobal.__chatProgrammaticScrollWrites?.push(top);
      if (typeof options === 'number') originalScrollTo(options, y ?? feed.scrollTop);
      else originalScrollTo(options);
    }) as typeof feed.scrollTo;
  });
  await clickUserMessageNavigatorRowContaining(page, marker);
  await page.waitForFunction(
    (expectedRowId) =>
      [...document.querySelectorAll<HTMLElement>('[data-chat-row-id]')].some(
        (candidate) => candidate.dataset.chatRowId === expectedRowId,
      ),
    rowId,
    { timeout: 20_000 },
  );
  const writesAtMount = await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatProgrammaticScrollWrites?: number[];
    };
    return browserGlobal.__chatProgrammaticScrollWrites?.length ?? 0;
  });
  await page.waitForFunction(
    (minimumWrites) => {
      const browserGlobal = globalThis as typeof globalThis & {
        __chatDelayedTargetGrowthFrame?: number;
        __chatProgrammaticScrollWrites?: number[];
      };
      return (
        (browserGlobal.__chatDelayedTargetGrowthFrame ?? 0) >= 5 &&
        (browserGlobal.__chatProgrammaticScrollWrites?.length ?? 0) > minimumWrites
      );
    },
    writesAtMount,
    { timeout: 20_000 },
  );
  const writesBeforeIntent = await page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __chatProgrammaticScrollWrites?: number[];
    };
    return browserGlobal.__chatProgrammaticScrollWrites?.length ?? 0;
  });
  const box = await page.locator(FEED_SELECTOR).boundingBox();
  if (!box) throw new Error('Transcript viewport has no interaction bounds.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  const writes = await withDiagnosticTimeout(
    'the cancelled navigator jump to stop writing',
    page.evaluate(async () => {
      const browserGlobal = globalThis as typeof globalThis & {
        __chatProgrammaticScrollWrites?: number[];
        __chatDelayedTargetGrowthFrame?: number;
        __restoreChatScrollTo?: () => void;
        __stopDelayedTargetGrowth?: () => void;
      };
      for (let frame = 0; frame < 2; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const afterCancellation = browserGlobal.__chatProgrammaticScrollWrites?.length ?? 0;
      for (let frame = 0; frame < 45; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const final = browserGlobal.__chatProgrammaticScrollWrites?.length ?? 0;
      const growthFrames = browserGlobal.__chatDelayedTargetGrowthFrame ?? 0;
      browserGlobal.__restoreChatScrollTo?.();
      browserGlobal.__stopDelayedTargetGrowth?.();
      delete browserGlobal.__restoreChatScrollTo;
      delete browserGlobal.__stopDelayedTargetGrowth;
      return {
        afterCancellation,
        final,
        growthFrames,
      };
    }),
  );
  expect(writesBeforeIntent).toBeGreaterThan(writesAtMount);
  expect(writes.growthFrames).toBeGreaterThanOrEqual(5);
  expect(writes.final).toBe(writes.afterCancellation);
  await page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
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
          hasTranscriptRow: Boolean(item.querySelector('[data-chat-row-id]')),
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
        transcriptItemCount: items.filter((item) => item.hasTranscriptRow).length,
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

async function mountedConversationDiscontinuities(
  page: Page,
): Promise<Array<{ previous: string; next: string; delta: number }>> {
  return page.locator(FEED_SELECTOR).evaluate((feedElement, itemSelector) => {
    const items = [...feedElement.querySelectorAll<HTMLElement>(itemSelector)]
      .map((item) => ({
        index: Number(item.dataset.index),
        key: item.dataset.chatVirtualItem ?? '',
        rect: item.getBoundingClientRect(),
      }))
      .filter((item) => Number.isFinite(item.index))
      .sort((left, right) => left.index - right.index);
    const discontinuities: Array<{ previous: string; next: string; delta: number }> = [];
    for (let index = 1; index < items.length; index += 1) {
      const previous = items[index - 1];
      const next = items[index];
      if (!previous || !next || next.index !== previous.index + 1) continue;
      const delta = next.rect.top - previous.rect.bottom;
      if (Math.abs(delta) > 1) {
        discontinuities.push({ previous: previous.key, next: next.key, delta });
      }
    }
    return discontinuities;
  }, ITEM_SELECTOR);
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

async function createTranscript(fixture: ChromiumFixture): Promise<string> {
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
  return chatId;
}

async function verifyEarlierPrefetchDuringProcessing(fixture: ChromiumFixture): Promise<void> {
  const chatId = await seedTranscript(fixture.integration, 90, 'chromium-processing-prefetch');
  await prepareTranscript(fixture, chatId);
  const prompt = 'chromium-processing-prefetch-held';
  const heldCompletion = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: prompt });
  let releaseFirstPage!: () => void;
  const firstPageGate = new Promise<void>((resolve) => (releaseFirstPage = resolve));
  let resolveFirstPageRequest!: () => void;
  const firstPageRequest = new Promise<void>((resolve) => (resolveFirstPageRequest = resolve));
  let resolveSecondPageRequest!: () => void;
  const secondPageRequest = new Promise<void>((resolve) => (resolveSecondPageRequest = resolve));
  let earlierRequestCount = 0;
  let turnId: string | null = null;

  await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('chatId') === chatId && url.searchParams.has('beforeSeq')) {
      earlierRequestCount += 1;
      if (earlierRequestCount === 1) {
        resolveFirstPageRequest();
        await firstPageGate;
      } else if (earlierRequestCount === 2) {
        resolveSecondPageRequest();
      }
    }
    await route.continue();
  });

  try {
    const accepted = await fixture.integration.client.runDirectChat({
      chatId,
      content: prompt,
      agent: fixture.integration.directAgents.openAi,
    });
    turnId = accepted.turnId ?? null;
    await withDiagnosticTimeout('the held processing turn', heldCompletion.received);
    await fixture.page.locator('[data-slot="chat-processing-status"]').waitFor({ state: 'visible' });
    const modelCountBeforePrefetch = await waitForStableModelCount(fixture.page, 50);

    const loadAheadDistance = await fixture.page.locator(FEED_SELECTOR).evaluate((feedElement) => {
      const feed = feedElement as HTMLElement;
      const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
      const start = Math.min(maximum, feed.clientHeight * 2.5);
      if (start <= feed.clientHeight * 2) {
        throw new Error('The transcript is too short to verify two-viewport load-ahead.');
      }
      feed.scrollTop = start;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      feed.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        }),
      );
      feed.scrollTop = feed.clientHeight * 1.5;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
      return feed.scrollTop;
    });
    await withDiagnosticTimeout('the first held earlier-page request', firstPageRequest);
    expect(loadAheadDistance).toBeGreaterThan(0);
    expect(await transcriptBoundaryIntersectsViewport(fixture.page, 'earlier')).toBe(false);

    releaseFirstPage();

    const modelCountAfterFirstPage = await waitForStableModelCount(
      fixture.page,
      modelCountBeforePrefetch + 50,
    );
    expect(earlierRequestCount).toBe(1);
    expect(modelCountAfterFirstPage).toBe(modelCountBeforePrefetch + 50);

    await fixture.page.locator(FEED_SELECTOR).evaluate((feedElement) => {
      const feed = feedElement as HTMLElement;
      feed.scrollTop = 0;
      feed.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    // A clamped viewport emits no scroll event for the subsequent upward gesture.
    await signalScrollIntent(fixture.page, 'earlier');
    await withDiagnosticTimeout('the clamped-gesture earlier-page request', secondPageRequest);
    const modelCountAfterPrefetch = await waitForModelCount(
      fixture.page,
      modelCountBeforePrefetch + 100,
    );
    expect(earlierRequestCount).toBe(2);
    expect(modelCountAfterPrefetch).toBe(modelCountBeforePrefetch + 100);
  } finally {
    releaseFirstPage();
    heldCompletion.releaseEcho();
    await fixture.page.unroute('**/api/v1/chats/messages?**');
  }

  if (turnId === null) throw new Error('The held processing turn was not accepted.');
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, turnId)).type).toBe(
    'agent-run-finished',
  );
  fixture.assertNoBrowserErrors();
}

async function prepareTranscript(
  fixture: ChromiumFixture,
  chatId: string,
  minimumModelCount = 50,
): Promise<{
  chatId: string;
  initialModelCount: number;
}> {
  return withDiagnosticTimeout(
    'the transcript fixture to be prepared',
    (async () => {
      const response = await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
        { waitUntil: 'domcontentloaded' },
      );
      if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);

      await waitForTranscriptReady(fixture.page);
      return {
        chatId,
        initialModelCount: await waitForStableModelCount(fixture.page, minimumModelCount),
      };
    })(),
    45_000,
  );
}

async function revealEarlierTranscript(
  page: Page,
  initialModelCount: number,
): Promise<{ anchor: ReadingAnchor; frames: ReadingAnchorFrameSample[] }> {
  return withDiagnosticTimeout(
    'the earlier transcript page to be revealed',
    (async () => {
      await scrollToPosition(page, 'middle');
      await signalScrollIntent(page, 'later');
      const prefetchPosition = await page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
        const feed = feedElement as HTMLElement;
        const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
        const target = Math.min(maximum, Math.max(101, feed.clientHeight * 0.75));
        feed.scrollTop = target;
        feed.dispatchEvent(new Event('scroll', { bubbles: true }));
        await settle();
        await settle();
        return {
          scrollTop: feed.scrollTop,
          viewportHeight: feed.clientHeight,
        };
      });
      expect(prefetchPosition.scrollTop).toBeGreaterThan(100);
      expect(prefetchPosition.scrollTop).toBeLessThanOrEqual(prefetchPosition.viewportHeight);
      const anchor = await readingAnchor(page);
      await startReadingAnchorFrameSampler(page, anchor);
      const previousRevision = await virtualDataRevision(page);
      await signalScrollIntent(page, 'earlier');
      await page.locator(FEED_SELECTOR).dispatchEvent('scroll');
      await waitForVirtualDataRevisionAfter(page, previousRevision);
      await waitForModelCount(page, initialModelCount + 1);
      return { anchor, frames: await finishReadingAnchorFrameSampler(page) };
    })(),
  );
}

async function verifyBoundedPrepend(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await scrollToPosition(fixture.page, 'end');
  await waitForDistanceFromEnd(fixture.page, 1);
  await verifyDetachedNearEndGrowth(fixture.page);
  const { anchor: prependAnchor, frames: prependFrames } = await revealEarlierTranscript(
    fixture.page,
    initialModelCount,
  );
  const restoredPrependAnchor = await anchorByKey(fixture.page, prependAnchor.key);
  expect(prependFrames.length).toBeGreaterThan(2);
  expect(
    Math.max(
      ...prependFrames.map((sample) =>
        sample.offset === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(sample.offset - prependAnchor.offset),
      ),
    ),
    JSON.stringify({ prependAnchor, prependFrames }, null, 2),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(restoredPrependAnchor.offset - prependAnchor.offset)).toBeLessThanOrEqual(1);

  const expandedGeometry = await transcriptGeometry(fixture.page);
  expect(expandedGeometry.modelCount).toBeGreaterThanOrEqual(100);
  expect(expandedGeometry.transcriptItemCount).toBeGreaterThan(0);
  expect(expandedGeometry.itemCount).toBeLessThan(60);
  expect(expandedGeometry.overlaps).toEqual([]);
  expect(expandedGeometry.horizontalOverflow).toEqual([]);
  fixture.assertNoBrowserErrors();
}

async function verifyGrowingNavigation(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await selectAndVerifyNavigatorTarget(fixture.page, 'chromium-virtual-turn-45');
  await selectAndVerifyDelayedNavigatorTarget(fixture.page, 'chromium-virtual-turn-38');
  fixture.assertNoBrowserErrors();
}

async function verifySelectionRetention(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await scrollToPosition(fixture.page, 'middle');
  const selected = await selectVisibleMessageText(fixture.page);
  await fixture.page.waitForFunction(
    ({ itemSelector, key, expectedText }) => {
      const selection = document.getSelection();
      return (
        selection?.toString() === expectedText &&
        [...document.querySelectorAll<HTMLElement>(itemSelector)].some(
          (item) => item.dataset.chatVirtualItem === key,
        )
      );
    },
    {
      itemSelector: ITEM_SELECTOR,
      key: selected.key,
      expectedText: selected.text,
    },
  );

  await scrollToPosition(fixture.page, selected.scrollTarget);
  const retained = await fixture.page.evaluate(
    ({ feedSelector, itemSelector, key, rowId }) => {
      const feed = document.querySelector<HTMLElement>(feedSelector);
      const wrapper = [...document.querySelectorAll<HTMLElement>(itemSelector)].find(
        (item) => item.dataset.chatVirtualItem === key,
      );
      const row = wrapper?.querySelector<HTMLElement>('[data-chat-row-id]');
      const selection = document.getSelection();
      if (!feed || !wrapper || !row || !selection) return null;
      if (row.dataset.chatRowId !== rowId) return null;
      const viewport = feed.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        rowId: row.dataset.chatRowId,
        text: selection.toString(),
        outsideViewport: rowRect.bottom < viewport.top || rowRect.top > viewport.bottom,
      };
    },
    {
      feedSelector: FEED_SELECTOR,
      itemSelector: ITEM_SELECTOR,
      key: selected.key,
      rowId: selected.rowId,
    },
  );
  expect(retained).toEqual({
    rowId: selected.rowId,
    text: selected.text,
    outsideViewport: true,
  });
  await releaseBrowserSelection(fixture.page);
  await fixture.page.waitForFunction(
    ({ itemSelector, key }) =>
      ![...document.querySelectorAll<HTMLElement>(itemSelector)].some(
        (item) => item.dataset.chatVirtualItem === key,
      ),
    { itemSelector: ITEM_SELECTOR, key: selected.key },
  );
  fixture.assertNoBrowserErrors();
}

async function verifyLaterPageReadingPosition(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  await prepareTranscript(fixture, chatId);
  await scrollToPosition(fixture.page, 'middle');
  const initialPrompt = fixture.page.locator('button[title="Scroll to initial prompt"]');
  await initialPrompt.waitFor({ state: 'visible' });
  const initialWindowRevision = await virtualDataRevision(fixture.page);
  await initialPrompt.click();
  await waitForVirtualDataRevisionAfter(fixture.page, initialWindowRevision);
  await waitForTranscriptReady(fixture.page);

  await signalScrollIntent(fixture.page, 'earlier');
  const prefetchPosition = await fixture.page
    .locator(FEED_SELECTOR)
    .evaluate(async (feedElement) => {
      const feed = feedElement as HTMLElement;
      const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const targetDistance = Math.max(51, feed.clientHeight * 0.75);
      let stableFrames = 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
        if (maximum > targetDistance) {
          feed.scrollTop = maximum - targetDistance;
          feed.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
        await settle();
        const distanceFromEnd = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
        stableFrames = Math.abs(distanceFromEnd - targetDistance) <= 1 ? stableFrames + 1 : 0;
        if (stableFrames >= 4) {
          return { distanceFromEnd, viewportHeight: feed.clientHeight };
        }
      }
      throw new Error('The later-page prefetch position did not settle.');
    });
  expect(prefetchPosition.distanceFromEnd).toBeGreaterThan(50);
  expect(prefetchPosition.distanceFromEnd).toBeLessThanOrEqual(prefetchPosition.viewportHeight);
  const anchor = await readingAnchor(fixture.page);
  const previousRevision = await virtualDataRevision(fixture.page);
  await signalScrollIntent(fixture.page, 'later');
  await fixture.page.locator(FEED_SELECTOR).dispatchEvent('scroll');
  await waitForVirtualDataRevisionAfter(fixture.page, previousRevision);
  const restored = await anchorByKey(fixture.page, anchor.key);
  expect(
    Math.abs(restored.offset - anchor.offset),
    JSON.stringify({ anchor, restored }),
  ).toBeLessThanOrEqual(1);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });

  const returnToLatest = fixture.page.locator('button[title="Scroll to bottom"]');
  await returnToLatest.waitFor({ state: 'visible' });
  const latestWindowRevision = await virtualDataRevision(fixture.page);
  await returnToLatest.click();
  await waitForVirtualDataRevisionAfter(fixture.page, latestWindowRevision);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'return-to-latest');
  await appendTurn(fixture.integration, chatId, 'chromium-later-window-live-append');
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-later-window-live-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'live-append-after-return');
  fixture.assertNoBrowserErrors();
}

async function verifyConcurrentAppendNavigation(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await selectNavigatorTargetDuringAppend(fixture, chatId, 'chromium-virtual-turn-36');
  fixture.assertNoBrowserErrors();
}

async function verifyEdgeNavigation(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await withDiagnosticTimeout(
    'the start-edge navigator target',
    selectAndVerifyEdgeNavigatorTarget(fixture.page, 'chromium-virtual-turn-0', 'start'),
    30_000,
  );
  await withDiagnosticTimeout(
    'the end-edge navigator target',
    selectAndVerifyEdgeNavigatorTarget(fixture.page, 'chromium-generation-prime', 'end'),
    30_000,
  );
  fixture.assertNoBrowserErrors();
}

async function verifyTargetCancellation(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await withDiagnosticTimeout(
    'the growing navigator target cancellation',
    interruptNavigatorJump(fixture.page, 'chromium-virtual-turn-40'),
    30_000,
  );
  fixture.assertNoBrowserErrors();
}

async function verifyAppendGeometry(fixture: ChromiumFixture, chatId: string): Promise<void> {
  await prepareTranscript(fixture, chatId);

  await scrollToPosition(fixture.page, 'middle');
  const detachedAnchor = await readingAnchor(fixture.page);
  await startReadingAnchorFrameSampler(fixture.page, detachedAnchor);
  await appendTurn(fixture.integration, chatId, 'chromium-detached-append');
  await fixture.page.getByRole('status').filter({ hasText: 'New response available' }).waitFor();
  const restoredDetachedAnchor = await anchorByKey(fixture.page, detachedAnchor.key);
  const detachedAppendFrames = await finishReadingAnchorFrameSampler(fixture.page);
  expect(detachedAppendFrames.length).toBeGreaterThan(2);
  expect(
    detachedAppendFrames.filter((sample) => sample.offset === null),
    JSON.stringify({ detachedAnchor, detachedAppendFrames }, null, 2),
  ).toEqual([]);
  expect(
    Math.max(
      ...detachedAppendFrames.map((sample) =>
        sample.offset === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(sample.offset - detachedAnchor.offset),
      ),
    ),
    JSON.stringify({ detachedAnchor, detachedAppendFrames }, null, 2),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(restoredDetachedAnchor.offset - detachedAnchor.offset),
    JSON.stringify({ detachedAnchor, restoredDetachedAnchor }),
  ).toBeLessThanOrEqual(1);
  expect((await transcriptGeometry(fixture.page)).distanceFromEnd).toBeGreaterThan(1);

  const hiddenAnchor = await readingAnchor(fixture.page);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });
  const chatSurfaceLabel = await activeMainSurfaceLabel(fixture.page);
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  await appendTurn(fixture.integration, chatId, 'chromium-hidden-append');
  await selectMainWorkspaceSurface(fixture.page, chatSurfaceLabel);
  await waitForTranscriptReady(fixture.page);
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: false,
    userScrolledUp: true,
  });
  const restoredHiddenAnchor = await anchorByKey(fixture.page, hiddenAnchor.key);
  expect(
    Math.abs(restoredHiddenAnchor.offset - hiddenAnchor.offset),
    JSON.stringify({ hiddenAnchor, restoredHiddenAnchor }),
  ).toBeLessThanOrEqual(1);

  await scrollToPosition(fixture.page, 'end');
  await appendTurn(fixture.integration, chatId, 'chromium-pinned-append');
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-pinned-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'pinned-append');

  const pinnedSurfaceLabel = await activeMainSurfaceLabel(fixture.page);
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  await appendTurn(fixture.integration, chatId, 'chromium-pinned-hidden-append');
  await selectMainWorkspaceSurface(fixture.page, pinnedSurfaceLabel);
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-pinned-hidden-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'pinned-hidden-append-show');
  fixture.assertNoBrowserErrors();
}

// Samples every frame across a chat switch and rejects visible end drift, paint-gate
// leaks, and post-reveal changes to the visible virtual row geometry.
async function expectNoSwitchPaintFlicker(
  fixture: ChromiumFixture,
  switchAction: () => Promise<void>,
): Promise<void> {
  const samples = fixture.page.locator(FEED_SELECTOR).evaluate(async (feedElement) => {
    const feed = feedElement as HTMLElement;
    const browserGlobal = globalThis as typeof globalThis & {
      __chatSwitchPaintSamplerReady?: boolean;
    };
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const surfaceOf = (): string => {
      const item = feed.querySelector<HTMLElement>('[data-chat-virtual-item]');
      const value = item?.dataset.chatVirtualItem;
      if (!value) return '';
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : '';
      } catch {
        return '';
      }
    };
    const initialSurface = surfaceOf();
    browserGlobal.__chatSwitchPaintSamplerReady = true;
    const violations: Array<Record<string, unknown>> = [];
    const transition: Array<Record<string, unknown>> = [];
    const visibleItemGeometry = () => {
      const feedRect = feed.getBoundingClientRect();
      return [...feed.querySelectorAll<HTMLElement>('[data-chat-virtual-item]')].flatMap((item) => {
        const rect = item.getBoundingClientRect();
        if (rect.bottom <= feedRect.top + 1 || rect.top >= feedRect.bottom - 1) return [];
        return [
          {
            key: item.dataset.chatVirtualItem ?? '',
            top: rect.top - feedRect.top,
            height: rect.height,
          },
        ];
      });
    };
    let switchObserved = false;
    let settledFrames = 0;
    let violationCount = 0;
    const beforeSwitch: Array<Record<string, unknown>> = [];
    let settledGeometry: ReturnType<typeof visibleItemGeometry> | null = null;
    for (let attempt = 0; attempt < 600 && settledFrames < 12; attempt += 1) {
      await frame();
      const content = feed.querySelector<HTMLElement>('[data-chat-feed-content]');
      if (!content) continue;
      const rowCount = content.querySelectorAll('[data-chat-virtual-item]').length;
      const busy = feed.getAttribute('aria-busy') === 'true';
      const contentVisible = getComputedStyle(content).visibility !== 'hidden';
      const scrollbar = [
        ...document.querySelectorAll<HTMLElement>('[data-chat-feed-scrollbar]'),
      ].find((candidate) => candidate.parentElement?.contains(feed));
      const scrollbarVisible = Boolean(
        scrollbar && scrollbar.isConnected && getComputedStyle(scrollbar).visibility !== 'hidden',
      );
      const distanceFromEnd = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
      const currentSurface = surfaceOf();
      if (currentSurface && currentSurface !== initialSurface) switchObserved = true;
      const sizer = feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]');
      const sample = {
        attempt,
        busy,
        contentVisible,
        scrollbarVisible,
        distanceFromEnd,
        scrollTop: feed.scrollTop,
        scrollHeight: feed.scrollHeight,
        clientHeight: feed.clientHeight,
        rowCount,
        modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
        totalSize: Number.parseFloat(sizer?.style.height ?? '0'),
        pinned: feed.dataset.chatPinnedToBottom,
        userScrolledUp: feed.dataset.chatUserScrolledUp,
        surface: currentSurface,
        path: location.pathname,
      };
      if (!switchObserved) {
        beforeSwitch.push(sample);
        if (beforeSwitch.length > 12) beforeSwitch.shift();
        continue;
      }
      if (transition.length === 0) transition.push(...beforeSwitch);
      if (transition.length < 36) transition.push(sample);
      const recordViolation = (violation: Record<string, unknown>): void => {
        violationCount += 1;
        if (violations.length < 12) violations.push(violation);
      };
      if (!contentVisible && scrollbarVisible) {
        recordViolation({ ...sample, kind: 'paint-gate-scrollbar-visible' });
      } else if (contentVisible && rowCount > 0 && Math.abs(distanceFromEnd) > 2) {
        recordViolation({ ...sample, kind: 'visible-end-drift' });
      }
      const settled = contentVisible && rowCount > 0 && Math.abs(distanceFromEnd) <= 1;
      if (settled) {
        const currentGeometry = visibleItemGeometry();
        if (settledGeometry) {
          const changed =
            currentGeometry.length !== settledGeometry.length ||
            currentGeometry.some((item, index) => {
              const previous = settledGeometry?.[index];
              return (
                !previous ||
                item.key !== previous.key ||
                Math.abs(item.top - previous.top) > 1 ||
                Math.abs(item.height - previous.height) > 1
              );
            });
          if (changed) {
            recordViolation({
              attempt,
              kind: 'settled-visible-geometry-changed',
              previous: settledGeometry,
              current: currentGeometry,
            });
          }
        } else {
          settledGeometry = currentGeometry;
        }
      } else if (settledGeometry) {
        recordViolation({ attempt, kind: 'settled-feed-became-unsettled', busy, contentVisible });
      }
      settledFrames = settled ? settledFrames + 1 : 0;
    }
    delete browserGlobal.__chatSwitchPaintSamplerReady;
    return { settledFrames, switchObserved, transition, violationCount, violations };
  });
  await fixture.page.waitForFunction(
    () =>
      Boolean(
        (globalThis as typeof globalThis & { __chatSwitchPaintSamplerReady?: boolean })
          .__chatSwitchPaintSamplerReady,
      ),
    undefined,
    { timeout: 5_000 },
  );
  await switchAction();
  const observed = await withDiagnosticTimeout('the switch paint samples', samples, 30_000);
  expect(observed.violationCount, JSON.stringify(observed, null, 2)).toBe(0);
  expect(observed.switchObserved, JSON.stringify(observed, null, 2)).toBe(true);
  expect(observed.settledFrames, JSON.stringify(observed, null, 2)).toBeGreaterThanOrEqual(12);
}

function heterogeneousAssistantResponse(index: number): string {
  const paragraphs = Array.from(
    { length: (index % 4) + 1 },
    (_, paragraph) =>
      `Paragraph ${paragraph + 1} for response ${index} exercises variable-height Markdown during chat restoration.`,
  ).join('\n\n');
  const code =
    index % 2 === 0
      ? `\n\n\`\`\`ts\nconst restoredRow${index} = { index: ${index}, stable: true };\nconsole.log(restoredRow${index});\n\`\`\``
      : '';
  return `## Heterogeneous response ${index}\n\n${paragraphs}${code}`;
}

async function seedHeterogeneousTranscript(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  for (let index = 0; index < 9; index += 1) {
    const toolOutput = Array.from(
      { length: (index % 4) + 1 },
      (_, line) => `heterogeneous-tool-${index}-line-${line + 1}`,
    ).join('\\n');
    environment.model.scriptTurn([
      claudeToolUse(`toolu_chromium_switch_${index}`, 'Bash', {
        command: `printf '%b' '${toolOutput}\\n'`,
      }),
    ]);
    environment.model.scriptTurn([claudeText(heterogeneousAssistantResponse(index))]);
    const accepted =
      index === 0
        ? await fixture.integration.client.startChat(
            liveClaudeStartRequest({
              chatId,
              projectPath: fixture.integration.dirs.project,
              command: `chromium-heterogeneous-switch-${index}`,
              permissionMode: 'bypassPermissions',
            }),
          )
        : await fixture.integration.client.runChat(
            liveClaudeRunRequest({
              chatId,
              command: `chromium-heterogeneous-switch-${index}`,
              permissionMode: 'bypassPermissions',
            }),
          );
    expect(
      (await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId)).type,
    ).toBe('agent-run-finished');
  }
  environment.model.assertSettled();
  return chatId;
}

async function verifyChatSwitchBottomRestore(
  fixture: ChromiumFixture,
  primaryChatId: string,
  environment: ScriptedClaudeTestEnvironment,
): Promise<void> {
  const secondaryMarker = 'chromium-heterogeneous-switch-0';
  const secondaryChatId = await seedHeterogeneousTranscript(fixture, environment);
  // The scripted start can select its newly created chat. Re-establishes the primary
  // surface before sampling the actual sidebar switch in either direction.
  await prepareTranscript(fixture, primaryChatId);
  await scrollToPosition(fixture.page, 'end');
  await waitForDistanceFromEnd(fixture.page, 1);

  await expectNoSwitchPaintFlicker(fixture, () =>
    selectSidebarChat(fixture.page, secondaryChatId, secondaryMarker),
  );
  await waitForStablePinnedTranscriptLayout(fixture.page, 'switch-to-secondary');
  const visibleHeights = await fixture.page.locator(ITEM_SELECTOR).evaluateAll((items) =>
    items.map((item) => Math.round((item as HTMLElement).getBoundingClientRect().height)),
  );
  expect(new Set(visibleHeights).size, JSON.stringify(visibleHeights)).toBeGreaterThanOrEqual(3);

  await expectNoSwitchPaintFlicker(fixture, () =>
    selectSidebarChat(fixture.page, primaryChatId, 'chromium-virtual-turn-0'),
  );
  await waitForStablePinnedTranscriptLayout(fixture.page, 'switch-back-to-primary');
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: true,
    userScrolledUp: false,
  });
  fixture.assertNoBrowserErrors();
}

async function verifyNativeHistoryReloadAfterStreaming(fixture: ChromiumFixture): Promise<void> {
  const chatId = await seedTranscript(fixture.integration, 15, 'chromium-native-reload-base');
  await prepareTranscript(fixture, chatId, 20);
  await scrollToPosition(fixture.page, 'end');
  await waitForStablePinnedTranscriptLayout(fixture.page, 'native-reload-baseline');

  const prompt = 'chromium-native-reload-stream';
  const accepted = await fixture.integration.client.runDirectChat({
    chatId,
    content: prompt,
    agent: fixture.integration.directAgents.openAi,
  });
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId)).type).toBe(
    'agent-run-finished',
  );
  await fixture.page.locator(FEED_SELECTOR).getByText(`echo:${prompt}`, { exact: true }).waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'native-reload-streamed');

  const beforeReload = await fixture.integration.client.getMessages(chatId);
  const eventCursor = fixture.integration.client.markEvents();
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Reload from native history');
  const reset = await fixture.integration.client.waitForEvent(
    (event): event is ChatGenerationResetMessage =>
      event.type === 'chat-generation-reset' &&
      event.chatId === chatId &&
      event.reason === 'manual-reload',
    'the native-history generation reset',
    { afterIndex: eventCursor },
  );

  // Includes the two viewport spacers and the desktop floating-toolbar spacer.
  const expectedModelCount = beforeReload.messages.length + 3;
  await waitForStableModelCount(fixture.page, expectedModelCount);
  const replacement = await fixture.page.locator(FEED_SELECTOR).evaluate(
    (feedElement, { oldGenerationId, nextGenerationId }) => {
      const feed = feedElement as HTMLElement;
      const rows = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')];
      const rowIds = rows.flatMap((row) => row.dataset.chatRowId ?? []);
      const sizer = feed.querySelector<HTMLElement>('[data-chat-virtual-sizer]');
      return {
        modelCount: Number(sizer?.dataset.chatVirtualModelCount ?? 0),
        mountedRowCount: rowIds.length,
        onlyNextGeneration: rowIds.every((rowId) => rowId.startsWith(`${nextGenerationId}:`)),
        oldGenerationMounted: rowIds.some((rowId) => rowId.startsWith(`${oldGenerationId}:`)),
      };
    },
    {
      oldGenerationId: beforeReload.generationId,
      nextGenerationId: reset.generationId,
    },
  );
  expect(replacement).toEqual({
    modelCount: expectedModelCount,
    mountedRowCount: expect.any(Number),
    onlyNextGeneration: true,
    oldGenerationMounted: false,
  });
  expect(replacement.mountedRowCount).toBeGreaterThan(0);
  expect(replacement.mountedRowCount).toBeLessThan(beforeReload.messages.length);
  expect(await surfaceIdentity(fixture.page)).toBe(`${chatId}:${reset.generationId}`);
  const exactTextCounts = await fixture.page.locator(FEED_SELECTOR).evaluate(
    (feed, expected) => {
      const leafTexts = [...feed.querySelectorAll<HTMLElement>('*')].flatMap((element) =>
        element.children.length === 0 ? [element.textContent?.trim() ?? ''] : [],
      );
      return expected.map((text) => leafTexts.filter((candidate) => candidate === text).length);
    },
    [prompt, `echo:${prompt}`],
  );
  expect(exactTextCounts).toEqual([1, 1]);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'native-reload-applied');
  expect(await viewportPolicy(fixture.page)).toEqual({
    pinned: true,
    userScrolledUp: false,
  });
  fixture.assertNoBrowserErrors();
}

async function verifyHiddenPortalCleanup(fixture: ChromiumFixture, chatId: string): Promise<void> {
  await prepareTranscript(fixture, chatId);
  await scrollToPosition(fixture.page, 'middle');
  const chatSurfaceLabel = await activeMainSurfaceLabel(fixture.page);
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  const terminalSurfaceLabel = await activeMainSurfaceLabel(fixture.page);
  await selectMainWorkspaceSurface(fixture.page, chatSurfaceLabel);
  await waitForTranscriptReady(fixture.page);
  await scrollToPosition(fixture.page, 'middle');

  const openVisibleMessageMenu = async (): Promise<void> => {
    await fixture.page.locator(FEED_SELECTOR).evaluate((feedElement) => {
      const feed = feedElement as HTMLElement;
      const viewport = feed.getBoundingClientRect();
      const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
        (candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.height > 1 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
        },
      );
      const trigger = row?.querySelector<HTMLElement>('[data-slot="context-menu-trigger"]');
      if (!trigger) throw new Error('No visible message menu trigger was available.');
      const rect = trigger.getBoundingClientRect();
      trigger.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
  };
  await openVisibleMessageMenu();
  const menu = fixture.page.locator('[data-slot="context-menu-content"]');
  await menu.waitFor({ state: 'visible' });
  await menu.getByRole('menuitem', { name: 'Copy text' }).focus();

  await selectMainWorkspaceSurfaceProgrammatically(fixture.page, terminalSurfaceLabel);
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  await menu.waitFor({ state: 'detached' });
  const hiddenState = await fixture.page.evaluate(() => {
    const layer = document.querySelector<HTMLElement>('[data-conversation-workspace-layer]');
    return {
      portalCount: document.querySelectorAll('[data-slot="context-menu-content"]').length,
      focusInsideHiddenConversation: Boolean(
        layer?.getAttribute('aria-hidden') === 'true' &&
        document.activeElement &&
        layer.contains(document.activeElement),
      ),
    };
  });
  expect(hiddenState).toEqual({
    portalCount: 0,
    focusInsideHiddenConversation: false,
  });

  await selectMainWorkspaceSurface(fixture.page, chatSurfaceLabel);
  await waitForTranscriptReady(fixture.page);
  await openVisibleMessageMenu();
  await menu.waitFor({ state: 'visible' });
  await fixture.page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
  fixture.assertNoBrowserErrors();
}

async function verifyTextScaleTransitions(fixture: ChromiumFixture, chatId: string): Promise<void> {
  await synchronizeNativeTranscriptGeneration(fixture, chatId);
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  await revealEarlierTranscript(fixture.page, initialModelCount);
  await scrollToPosition(fixture.page, 'middle');
  await seedTranscript(fixture.integration, 1);

  const detachedAnchor = await readingAnchor(fixture.page);
  const detachedIdentity = await surfaceIdentity(fixture.page);
  const detachedPolicy = await viewportPolicy(fixture.page);
  const detachedLayout = await transcriptLayoutSnapshot(fixture.page, detachedAnchor.key);
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Split view');
  await waitForTranscriptScale(fixture.page, 0.85);
  const splitAnchor = await anchorByKey(fixture.page, detachedAnchor.key, {
    phase: 'post-split-scale',
    detachedAnchor,
    detachedIdentity,
    detachedPolicy,
    detachedLayout,
  });
  const splitLayout = await transcriptLayoutSnapshot(fixture.page, detachedAnchor.key);
  expect(
    Math.abs(splitAnchor.offset - detachedAnchor.offset),
    JSON.stringify({ detachedAnchor, splitAnchor, detachedLayout, splitLayout }, null, 2),
  ).toBeLessThanOrEqual(1);
  const splitGeometry = await transcriptGeometry(fixture.page);
  expect(splitGeometry.overlaps).toEqual([]);
  expect(splitGeometry.horizontalOverflow).toEqual([]);

  const originalSurfaceIdentity = await surfaceIdentity(fixture.page);
  const originalPaneId = await fixture.page
    .locator('[data-pane-id]')
    .first()
    .getAttribute('data-pane-id');
  if (!originalPaneId) throw new Error('The original split pane is missing its identity.');
  const thirdChatId = await seedTranscript(fixture.integration, 1);
  await addSidebarChatToSplit(fixture.page, thirdChatId);
  const fourthChatId = await seedTranscript(fixture.integration, 1);
  await addSidebarChatToSplit(fixture.page, fourthChatId);
  await fixture.page
    .locator(`[data-pane-id="${originalPaneId}"]`)
    .locator(':scope > [role="button"]')
    .first()
    .click();
  await fixture.page.waitForFunction(
    ({ itemSelector, expectedIdentity }) =>
      [...document.querySelectorAll<HTMLElement>(itemSelector)].some((item) => {
        const value = item.dataset.chatVirtualItem;
        if (!value) return false;
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) && parsed[0] === expectedIdentity;
        } catch {
          return false;
        }
      }),
    { itemSelector: ITEM_SELECTOR, expectedIdentity: originalSurfaceIdentity },
  );
  await waitForTranscriptReady(fixture.page);
  await waitForTranscriptScale(fixture.page, 0.7);
  await scrollToPosition(fixture.page, 'middle');
  const fourPaneAnchor = await readingAnchor(fixture.page);
  const fourPaneLayout = await transcriptLayoutSnapshot(fixture.page, fourPaneAnchor.key);
  const fourPaneGeometry = await transcriptGeometry(fixture.page);
  expect(fourPaneGeometry.overlaps).toEqual([]);
  expect(fourPaneGeometry.horizontalOverflow).toEqual([]);

  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Exit split view');
  await waitForTranscriptScale(fixture.page, 1);
  const restoredAnchor = await anchorByKey(fixture.page, fourPaneAnchor.key);
  const restoredLayout = await transcriptLayoutSnapshot(fixture.page, fourPaneAnchor.key);
  expect(
    Math.abs(restoredAnchor.offset - fourPaneAnchor.offset),
    JSON.stringify({ fourPaneAnchor, restoredAnchor, fourPaneLayout, restoredLayout }, null, 2),
  ).toBeLessThanOrEqual(1);
  const restoredGeometry = await transcriptGeometry(fixture.page);
  expect(restoredGeometry.overlaps).toEqual([]);
  expect(restoredGeometry.horizontalOverflow).toEqual([]);

  await scrollToPosition(fixture.page, 'end');
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Split view');
  await waitForTranscriptScale(fixture.page, 0.85);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'visible-scale-enter');
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Exit split view');
  await waitForTranscriptScale(fixture.page, 1);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'visible-scale-exit');

  // Publishes new geometry while an already-scaled surface is hidden. The show-time
  // attachment must restore the pinned end before the later visible scale reset.
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Split view');
  await waitForTranscriptScale(fixture.page, 0.85);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'hidden-scale-enter');
  const scaleSurfaceLabel = await activeMainSurfaceLabel(fixture.page);
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'New Terminal');
  await fixture.page.locator(FEED_SELECTOR).waitFor({ state: 'hidden' });
  const hiddenAppendMarker = 'chromium-hidden-scaled-append';
  await appendTurn(fixture.integration, chatId, hiddenAppendMarker);
  await selectMainWorkspaceSurface(fixture.page, scaleSurfaceLabel);
  await waitForTranscriptScale(fixture.page, 0.85);
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText(`echo:${hiddenAppendMarker}`, { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'hidden-scale-show');
  await openMainWorkspaceActions(fixture.page);
  await clickMenuItem(fixture.page, 'Exit split view');
  await waitForTranscriptScale(fixture.page, 1);
  await waitForStablePinnedTranscriptLayout(fixture.page, 'hidden-scale-exit');
  fixture.assertNoBrowserErrors();
}

async function verifyCountShrinkMeasurements(fixture: ChromiumFixture): Promise<void> {
  const chatId = await seedTranscript(fixture.integration, 110, 'chromium-count-shrink');
  const { initialModelCount } = await prepareTranscript(fixture, chatId);
  let expandedModelCount = initialModelCount;
  for (let pageIndex = 0; pageIndex < 4 && expandedModelCount <= 200; pageIndex += 1) {
    await revealEarlierTranscript(fixture.page, expandedModelCount);
    expandedModelCount = await waitForStableModelCount(fixture.page, expandedModelCount + 1);
  }
  expect(expandedModelCount).toBeGreaterThan(200);

  await scrollToPosition(fixture.page, 'end', false);
  expect((await viewportPolicy(fixture.page)).pinned).toBe(false);
  await signalScrollIntent(fixture.page, 'later');
  await fixture.page.locator(FEED_SELECTOR).dispatchEvent('scroll');
  await fixture.page.waitForFunction(
    ({ selector, previousCount }) => {
      const sizer = document.querySelector<HTMLElement>(selector);
      const current = Number(sizer?.dataset.chatVirtualModelCount ?? 0);
      return current > 0 && current < previousCount;
    },
    { selector: SIZER_SELECTOR, previousCount: expandedModelCount },
    { timeout: 20_000 },
  );
  await waitForStablePinnedTranscriptLayout(fixture.page, 'post-compaction');

  const compactedGeometry = await transcriptGeometry(fixture.page);
  expect(compactedGeometry.modelCount).toBeLessThan(expandedModelCount);
  expect(compactedGeometry.itemCount).toBeGreaterThan(2);
  expect(compactedGeometry.transcriptItemCount).toBeGreaterThan(1);
  expect(compactedGeometry.overlaps).toEqual([]);
  expect(await mountedConversationDiscontinuities(fixture.page)).toEqual([]);

  await appendTurn(fixture.integration, chatId, 'chromium-post-shrink-append');
  await fixture.page
    .locator(FEED_SELECTOR)
    .getByText('echo:chromium-post-shrink-append', { exact: true })
    .waitFor();
  await waitForStablePinnedTranscriptLayout(fixture.page, 'post-shrink-publication');
  const postPublicationGeometry = await transcriptGeometry(fixture.page);
  expect(postPublicationGeometry.overlaps).toEqual([]);
  expect(await mountedConversationDiscontinuities(fixture.page)).toEqual([]);
  fixture.assertNoBrowserErrors();
}

async function seedPermissionTranscript(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  for (let index = 0; index < 8; index += 1) {
    environment.model.scriptTurn([claudeText(`permission history response ${index}`)]);
    const accepted =
      index === 0
        ? await fixture.integration.client.startChat(
            liveClaudeStartRequest({
              chatId,
              projectPath: fixture.integration.dirs.project,
              command: `permission history prompt ${index}`,
            }),
          )
        : await fixture.integration.client.runChat(
            liveClaudeRunRequest({
              chatId,
              command: `permission history prompt ${index}`,
            }),
          );
    expect(
      (await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId)).type,
    ).toBe('agent-run-finished');
  }

  environment.model.scriptTurn([
    claudeToolUse('toolu_chromium_ask', 'AskUserQuestion', {
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Use the durable database.' },
            { label: 'SQLite', description: 'Use the embedded database.' },
          ],
        },
      ],
    }),
  ]);
  const cursor = fixture.integration.client.markEvents();
  await fixture.integration.client.runChat(
    liveClaudeRunRequest({
      chatId,
      command: 'ask the database question',
      permissionMode: 'bypassPermissions',
    }),
  );
  const event = await fixture.integration.client.waitForEvent(
    (candidate): candidate is ChatMessagesMessage =>
      candidate.type === 'chat-messages' &&
      candidate.chatId === chatId &&
      candidate.messages.some((entry) => entry.message.type === 'permission-request'),
    'the Chromium permission request',
    { afterIndex: cursor, timeoutMs: 30_000 },
  );
  expect(event.messages.some((entry) => entry.message.type === 'permission-request')).toBe(true);
  return chatId;
}

async function verifyPermissionDraftPersistence(
  fixture: ChromiumFixture,
  environment: ScriptedClaudeTestEnvironment,
): Promise<void> {
  const chatId = await seedPermissionTranscript(fixture, environment);
  await fixture.page.setViewportSize({ width: 900, height: 360 });
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await waitForTranscriptReady(fixture.page);

  const postgres = fixture.page.getByRole('radio', { name: /Postgres/ });
  await postgres.waitFor({ state: 'visible' });
  await postgres.check();
  expect(await postgres.isChecked()).toBe(true);
  const permissionItem = fixture.page.locator(ITEM_SELECTOR).filter({ has: postgres });
  const permissionKey = await permissionItem.getAttribute('data-chat-virtual-item');
  if (!permissionKey) throw new Error('The permission row is missing its virtual identity.');

  await fixture.page.locator(FEED_SELECTOR).focus();
  await fixture.page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
  await scrollToPosition(fixture.page, 'start');
  await fixture.page.waitForFunction(
    ({ itemSelector, key }) =>
      ![...document.querySelectorAll<HTMLElement>(itemSelector)].some(
        (item) => item.dataset.chatVirtualItem === key,
      ),
    { itemSelector: ITEM_SELECTOR, key: permissionKey },
  );

  await scrollToPosition(fixture.page, 'end');
  const restoredPostgres = fixture.page.getByRole('radio', {
    name: /Postgres/,
  });
  await restoredPostgres.waitFor({ state: 'visible' });
  expect(await restoredPostgres.isChecked()).toBe(true);
  environment.model.assertSettled();
  fixture.assertNoBrowserErrors();
}

describe('Chromium transcript virtualization', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;
  let browser: Browser | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
    try {
      browser = await launchChromiumBrowser();
    } catch (error) {
      environment.dispose();
      environment = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    try {
      if (browser) await closeChromiumBrowser(browser);
    } finally {
      environment?.dispose();
    }
  });

  test('preserves virtual transcript geometry across paging, appends, and scale', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-virtualization-geometry',
      async (fixture, markPhase) => {
        markPhase('creating the geometry transcript');
        const chatId = await createTranscript(fixture);
        markPhase('verifying bounded prepend geometry');
        await verifyBoundedPrepend(fixture, chatId);
        markPhase('verifying later-page reading position');
        await verifyLaterPageReadingPosition(fixture, chatId);
        markPhase('verifying detached, hidden, and pinned append geometry');
        await verifyAppendGeometry(fixture, chatId);
        markPhase('verifying chat-switch end restoration');
        await verifyChatSwitchBottomRestore(fixture, chatId, testEnvironment);
        markPhase('verifying detached and pinned text-scale transitions');
        await verifyTextScaleTransitions(fixture, chatId);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('prefetches earlier history while the active turn is processing', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-processing-prefetch',
      async (fixture, markPhase) => {
        markPhase('prefetching earlier history during a held processing turn');
        await verifyEarlierPrefetchDuringProcessing(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('navigates unmounted transcript rows and respects user cancellation', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-virtualization-navigation',
      async (fixture, markPhase) => {
        markPhase('creating the navigation transcript');
        const chatId = await createTranscript(fixture);
        markPhase('verifying stable and growing target navigation');
        await verifyGrowingNavigation(fixture, chatId);
        markPhase('verifying navigation during a concurrent append');
        await verifyConcurrentAppendNavigation(fixture, chatId);
        markPhase('verifying fresh start- and end-edge navigation');
        await verifyEdgeNavigation(fixture, chatId);
        markPhase('verifying user cancellation during target growth');
        await verifyTargetCancellation(fixture, chatId);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('retains transcript interactions and closes hidden transients', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    await withChromiumFixture(
      'transcript-virtualization-retention',
      async (fixture, markPhase) => {
        markPhase('creating the retention transcript');
        const chatId = await createTranscript(fixture);
        markPhase('verifying selection retention outside overscan');
        await verifySelectionRetention(fixture, chatId);
        markPhase('verifying portal cleanup before the Chat surface hides');
        await verifyHiddenPortalCleanup(fixture, chatId);
        markPhase('verifying permission draft persistence outside overscan');
        await verifyPermissionDraftPersistence(fixture, testEnvironment);
      },
      diagnostics,
      { serverEnvironment: testEnvironment.serverEnvironment },
      browser,
    );
  }, 180_000);

  test('rebuilds a completed streamed turn from native history', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-native-history-reload',
      async (fixture, markPhase) => {
        markPhase('streaming and reloading the native transcript');
        await verifyNativeHistoryReloadAfterStreaming(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 120_000);

  test('preserves survivor geometry after live-edge compaction and a later publication', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    await withChromiumFixture(
      'transcript-count-shrink-measurements',
      async (fixture, markPhase) => {
        markPhase('expanding and compacting the transcript window');
        await verifyCountShrinkMeasurements(fixture);
      },
      diagnostics,
      { serverEnvironment: environment.serverEnvironment },
      browser,
    );
  }, 180_000);
});
