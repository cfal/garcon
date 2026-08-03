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
  transcriptItemCount: number;
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
  await page.locator(FEED_SELECTOR).evaluate(
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

async function userMessageNavigatorRowIdContaining(page: Page, text: string): Promise<string> {
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
  await page.waitForTimeout(1_250);
  expect(await page.getByText('User messages', { exact: true }).isVisible()).toBe(false);
  expect(
    await page.locator(FEED_SELECTOR).evaluate(
      (feedElement, input) => {
        const feed = feedElement as HTMLElement;
        const row = [...feed.querySelectorAll<HTMLElement>('[data-chat-row-id]')].find(
          (candidate) => candidate.dataset.chatRowId === input.rowId,
        );
        const atEdge =
          input.edge === 'start'
            ? feed.scrollTop <= 1
            : feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 1;
        return Boolean(row && atEdge);
      },
      { rowId, edge },
    ),
  ).toBe(true);
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
  const modelCount = await waitForModelCount(fixture.page, 1);
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

  await appendTurn(fixture.integration, chatId, 'chromium-target-concurrent-append');
  await waitForModelCount(fixture.page, modelCount + 2);
  await fixture.page.evaluate(() => {
    const browserGlobal = globalThis as typeof globalThis & {
      __completeHeldChatTarget?: () => void;
    };
    browserGlobal.__completeHeldChatTarget?.();
  });

  await waitForRowCentered(fixture.page, rowId);
  await fixture.page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
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
  const writes = await page.evaluate(async () => {
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
    browserGlobal.__restoreChatScrollTo?.();
    browserGlobal.__stopDelayedTargetGrowth?.();
    delete browserGlobal.__restoreChatScrollTo;
    delete browserGlobal.__stopDelayedTargetGrowth;
    return {
      afterCancellation,
      final,
      growthFrames: browserGlobal.__chatDelayedTargetGrowthFrame ?? 0,
    };
  });
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
        await verifyDetachedNearEndGrowth(fixture.page);
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
        expect(Math.abs(restoredPrependAnchor.offset - prependAnchor.offset)).toBeLessThanOrEqual(
          1,
        );

        const expandedGeometry = await transcriptGeometry(fixture.page);
        expect(expandedGeometry.modelCount).toBeGreaterThanOrEqual(100);
        expect(expandedGeometry.transcriptItemCount).toBeGreaterThan(0);
        expect(expandedGeometry.itemCount).toBeLessThan(60);
        expect(expandedGeometry.overlaps).toEqual([]);
        expect(expandedGeometry.horizontalOverflow).toEqual([]);

        await openMainWorkspaceActions(fixture.page);
        await clickMenuItem(fixture.page, 'Jump to user message');
        await fixture.page.getByText('User messages', { exact: true }).waitFor();
        const targetRowId = await userMessageNavigatorRowIdContaining(
          fixture.page,
          'chromium-virtual-turn-45',
        );
        await clickUserMessageNavigatorRowContaining(fixture.page, 'chromium-virtual-turn-45');
        await fixture.page.getByText('User messages', { exact: true }).waitFor({ state: 'hidden' });
        await waitForRowCentered(fixture.page, targetRowId);
        await selectAndVerifyDelayedNavigatorTarget(fixture.page, 'chromium-virtual-turn-38');
        await selectNavigatorTargetDuringAppend(fixture, chatId, 'chromium-virtual-turn-36');
        await selectAndVerifyEdgeNavigatorTarget(fixture.page, 'chromium-virtual-turn-11', 'start');
        await selectAndVerifyEdgeNavigatorTarget(fixture.page, 'chromium-generation-prime', 'end');
        await interruptNavigatorJump(fixture.page, 'chromium-virtual-turn-40');

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
        await waitForDistanceFromEnd(fixture.page, 1);
        expect((await transcriptGeometry(fixture.page)).distanceFromEnd).toBeLessThanOrEqual(1);

        fixture.assertNoBrowserErrors();
      },
      diagnostics,
    );
  }, 120_000);
});
