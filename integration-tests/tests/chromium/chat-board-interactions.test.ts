import { describe, expect, test } from 'bun:test';
import type {
  ChatBoard,
  ChatBoardCatalog,
  ChatBoardMutationResponse,
  CreateChatBoardResponse,
} from '../../../common/chat-boards.js';
import type { ChatTagsMutationResponse } from '../../../common/chat-tag-mutations.js';
import {
  withChromiumFixture,
  type ChromiumFixture,
} from '../../support/chromium-fixture.js';

const READY_COLUMN_ID = '22222222-2222-4222-8222-222222222222';
const REVIEW_COLUMN_ID = '33333333-3333-4333-8333-333333333333';
const CHAT_COUNT = 24;
const LONG_CARD_TAGS = [
  'customer-experience',
  'release-management',
  'frontend-platform',
  'production-support',
  'quality-assurance',
  'security-review',
  'urgent',
] as const;

async function seedBoard(fixture: ChromiumFixture): Promise<void> {
  const catalog = await fixture.integration.client.get<ChatBoardCatalog>('/api/v1/chat-boards');
  const created = await fixture.integration.client.post<CreateChatBoardResponse>(
    '/api/v1/chat-boards',
    { expectedRevision: catalog.revision, name: 'Delivery' },
  );
  const board: ChatBoard = {
    id: created.boardId,
    name: 'Delivery',
    columns: [
      { id: READY_COLUMN_ID, name: 'Ready', match: 'all', tags: ['ready'] },
      { id: REVIEW_COLUMN_ID, name: 'Review', match: 'all', tags: ['review'] },
    ],
  };
  await fixture.integration.client.put<ChatBoardMutationResponse>('/api/v1/chat-boards', {
    expectedRevision: created.catalog.revision,
    board,
  });
}

async function seedChats(fixture: ChromiumFixture, count: number): Promise<string> {
  let firstChatId = '';
  for (let index = 0; index < count; index += 1) {
    const chatId = fixture.integration.newChatId();
    if (!firstChatId) firstChatId = chatId;
    const started = await fixture.integration.client.startDirectChat({
      chatId,
      content: `Synthetic board card ${index + 1}`,
      projectPath: fixture.integration.dirs.project,
      agent: fixture.integration.directAgents.openAi,
    });
    await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
    await fixture.integration.client.patch<ChatTagsMutationResponse>('/api/v1/chats/tags/delta', {
      chatId,
      addTags: ['ready', 'review', ...LONG_CARD_TAGS],
    });
  }
  return firstChatId;
}

async function openBoard(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page
    .locator('[data-workspace-window-current="true"] [data-workspace-window-add-trigger]')
    .click();
  await fixture.page.getByRole('menuitem', { name: 'Open Chat Board', exact: true }).click();
  await fixture.page.locator('[data-chat-board-panel]').waitFor({ state: 'visible' });
  await fixture.page.locator(`[data-chat-board-lane-list="${READY_COLUMN_ID}"]`).waitFor();
}

async function setLaneScroll(fixture: ChromiumFixture, columnId: string, ratio: number): Promise<number> {
  return fixture.page.locator(`[data-chat-board-lane-list="${columnId}"]`).evaluate(
    (element, requestedRatio) => {
      const viewport = element as HTMLElement;
      const maximum = viewport.scrollHeight - viewport.clientHeight;
      if (maximum <= 0) throw new Error('Chat Board lane is not scrollable.');
      viewport.scrollTop = Math.round(maximum * requestedRatio);
      viewport.dispatchEvent(new Event('scroll'));
      return viewport.scrollTop;
    },
    ratio,
  );
}

async function expectLaneScroll(
  fixture: ChromiumFixture,
  columnId: string,
  expected: number,
  tolerance?: number,
): Promise<void> {
  const selector = `[data-chat-board-lane-list="${columnId}"]`;
  try {
    await fixture.page.waitForFunction(
      ({ selector: laneSelector, scrollTop, allowedDifference }) => {
        const element = document.querySelector<HTMLElement>(laneSelector);
        return element !== null && Math.abs(element.scrollTop - scrollTop) <= allowedDifference;
      },
      {
        selector,
        scrollTop: expected,
        allowedDifference: tolerance ?? Math.max(12, expected * 0.25),
      },
    );
  } catch (error) {
    const actual = await fixture.page.locator(selector).evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    throw new Error(
      `Expected lane ${columnId} scrollTop ${expected}, received ${JSON.stringify(actual)}.`,
      { cause: error },
    );
  }
  if (tolerance === undefined) return;
  const settled = await settledLaneScrollTop(fixture, columnId);
  if (Math.abs(settled - expected) > tolerance) {
    throw new Error(`Expected settled lane ${columnId} scrollTop ${expected}, received ${settled}.`);
  }
}

async function settledLaneScrollTop(fixture: ChromiumFixture, columnId: string): Promise<number> {
  return fixture.page.locator(`[data-chat-board-lane-list="${columnId}"]`).evaluate(async (element) => {
    let previous = element.scrollTop;
    let stableFrames = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = element.scrollTop;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames === 3) return current;
    }
    throw new Error('Chat Board lane scroll did not settle within 60 animation frames.');
  });
}

async function constrainBoardWidth(fixture: ChromiumFixture, width: number | null): Promise<void> {
  await fixture.page.locator('[data-chat-board-panel]').evaluate((element, constrainedWidth) => {
    if (constrainedWidth === null) {
      element.style.removeProperty('width');
      element.style.removeProperty('max-width');
      element.style.removeProperty('flex');
      return;
    }
    element.style.width = `${constrainedWidth}px`;
    element.style.maxWidth = `${constrainedWidth}px`;
    element.style.flex = '0 0 auto';
  }, width);
}

async function resizeBoardDuringRemount(
  fixture: ChromiumFixture,
  firstWidth: number,
  finalWidth: number,
): Promise<void> {
  await fixture.page.locator('[data-chat-board-panel]').evaluate(
    async (element, widths) => {
      const narrowPresentation = new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          if (element.dataset.presentationBand !== 'narrow') return;
          observer.disconnect();
          resolve();
        });
        observer.observe(element, {
          attributes: true,
          attributeFilter: ['data-presentation-band'],
        });
      });
      element.style.width = `${widths.first}px`;
      element.style.maxWidth = `${widths.first}px`;
      element.style.flex = '0 0 auto';
      await narrowPresentation;
      element.style.width = `${widths.final}px`;
      element.style.maxWidth = `${widths.final}px`;
    },
    { first: firstWidth, final: finalWidth },
  );
}

async function expectTransitionFocus(
  fixture: ChromiumFixture,
  columnId: string,
  chatId?: string,
): Promise<void> {
  try {
    await fixture.page.waitForFunction(
      ({ expectedColumnId, expectedChatId }) => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement &&
          (!expectedChatId ||
            active.closest<HTMLElement>('[data-chat-board-chat-id]')?.dataset.chatBoardChatId === expectedChatId) &&
          active.matches(
            `[data-chat-board-column-id="${expectedColumnId}"] [data-chat-board-occurrence] [data-chat-board-focus-target="transition"]`,
          )
        );
      },
      { expectedColumnId: columnId, expectedChatId: chatId },
    );
  } catch (error) {
    const actual = await fixture.page.evaluate(() => ({
      active: document.activeElement?.outerHTML ?? null,
      presentationBand: document.querySelector('[data-chat-board-panel]')?.getAttribute(
        'data-presentation-band',
      ),
    }));
    throw new Error(`Expected transition focus in column ${columnId}, received ${JSON.stringify(actual)}.`, {
      cause: error,
    });
  }
}

async function focusReviewDuringNextDesktopMount(fixture: ChromiumFixture): Promise<void> {
  await fixture.page.evaluate(
    (reviewColumnId) =>
      new Promise<void>((resolve) => {
        const focusReview = () => {
          const panel = document.querySelector<HTMLElement>(
            '[data-chat-board-panel]:not([data-presentation="mobile"])',
          );
          const heading = panel?.querySelector<HTMLElement>(
            `[data-chat-board-lane-heading="${reviewColumnId}"]`,
          );
          if (!heading) return false;
          queueMicrotask(() => {
            heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
            heading.focus();
            resolve();
          });
          return true;
        };
        if (focusReview()) return;
        const observer = new MutationObserver(() => {
          if (!focusReview()) return;
          observer.disconnect();
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }),
    REVIEW_COLUMN_ID,
  );
}

describe('Chromium Chat Board interactions', () => {
  test('preserves responsive interaction state and detailed tag geometry', async () => {
    await withChromiumFixture('chat-board-responsive-interactions', async (fixture, markPhase) => {
      await fixture.page.setViewportSize({ width: 1_440, height: 600 });
      markPhase('seeding the board and overlapping cards');
      await seedBoard(fixture);
      const firstChatId = await seedChats(fixture, CHAT_COUNT);

      markPhase('opening the board and cancelling a transition');
      await openBoard(fixture, firstChatId);
      const invoker = fixture.page
        .locator(
          `[data-chat-board-column-id="${READY_COLUMN_ID}"] [data-chat-board-occurrence] button[aria-label="Transition…"]`,
        )
        .first();
      await invoker.click();
      await fixture.page.getByRole('dialog', { name: 'Transition Chat' }).waitFor();
      await fixture.page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(await invoker.evaluate((element) => document.activeElement === element)).toBe(true);

      markPhase('preserving focus through live virtual reordering');
      const reorderedChatId = await invoker.evaluate((element) => {
        const card = element.closest<HTMLElement>('[data-chat-board-chat-id]');
        if (!card?.dataset.chatBoardChatId) throw new Error('Expected a focused Chat Board card.');
        return card.dataset.chatBoardChatId;
      });
      await invoker.focus();
      await fixture.integration.client.reorderChat({
        chatId: reorderedChatId,
        placement: { kind: 'boundary', boundary: 'bottom' },
      });
      await fixture.page.waitForFunction(
        ({ chatId, expectedIndex, columnId }) => {
          const card = document.querySelector<HTMLElement>(
            `[data-chat-board-column-id="${columnId}"] [data-chat-board-chat-id="${chatId}"]`,
          );
          return (
            card?.dataset.chatBoardOccurrenceIndex === String(expectedIndex) &&
            document.activeElement ===
              card.querySelector('[data-chat-board-focus-target="transition"]')
          );
        },
        { chatId: reorderedChatId, expectedIndex: CHAT_COUNT - 1, columnId: READY_COLUMN_ID },
      );
      markPhase('recording independent lane scroll positions');
      const readyScrollTop = await setLaneScroll(fixture, READY_COLUMN_ID, 0.4);
      const reviewScrollTop = await setLaneScroll(fixture, REVIEW_COLUMN_ID, 0.7);
      expect(readyScrollTop).toBeGreaterThan(0);
      expect(reviewScrollTop).toBeGreaterThan(0);

      markPhase('switching lanes after entering narrow presentation');
      await constrainBoardWidth(fixture, 480);
      await fixture.page.locator('[data-chat-board-panel][data-presentation-band="narrow"]').waitFor();
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);
      await fixture.page.getByRole('tab', { name: `Review ${CHAT_COUNT}`, exact: true }).click();
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);
      await fixture.page.getByRole('tab', { name: `Ready ${CHAT_COUNT}`, exact: true }).click();
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);
      const settledReadyScrollTop = await settledLaneScrollTop(fixture, READY_COLUMN_ID);
      await fixture.page.getByRole('tab', { name: `Review ${CHAT_COUNT}`, exact: true }).click();
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);
      const settledReviewScrollTop = await settledLaneScrollTop(fixture, REVIEW_COLUMN_ID);

      markPhase('repeating narrow lane switches without scroll drift');
      for (let index = 0; index < 8; index += 1) {
        await fixture.page.getByRole('tab', { name: `Ready ${CHAT_COUNT}`, exact: true }).click();
        await expectLaneScroll(fixture, READY_COLUMN_ID, settledReadyScrollTop, 1);
        await fixture.page.getByRole('tab', { name: `Review ${CHAT_COUNT}`, exact: true }).click();
        await expectLaneScroll(fixture, REVIEW_COLUMN_ID, settledReviewScrollTop, 1);
      }
      await fixture.page.getByRole('tab', { name: `Ready ${CHAT_COUNT}`, exact: true }).click();
      await expectLaneScroll(fixture, READY_COLUMN_ID, settledReadyScrollTop, 1);

      markPhase('restoring both lanes after leaving narrow presentation');
      await constrainBoardWidth(fixture, null);
      await fixture.page
        .locator('[data-chat-board-panel]:not([data-presentation-band="narrow"])')
        .waitFor();
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);

      markPhase('coalescing consecutive presentation changes');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const focusedChatId = await invoker.evaluate((element) => {
          const chatId = element.closest<HTMLElement>(
            '[data-chat-board-chat-id]',
          )?.dataset.chatBoardChatId;
          (element as HTMLElement).focus({ preventScroll: true });
          return chatId;
        });
        if (!focusedChatId) throw new Error('Expected a focused Chat Board card.');
        await resizeBoardDuringRemount(fixture, 480, 1_000);
        await fixture.page.locator('[data-chat-board-panel][data-presentation-band="wide"]').waitFor();
        await expectTransitionFocus(fixture, READY_COLUMN_ID, focusedChatId);
      }
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);

      markPhase('releasing the virtual focus pin after focus leaves the board');
      const reorderedCard = fixture.page.locator(
        `[data-chat-board-column-id="${READY_COLUMN_ID}"] [data-chat-board-chat-id="${reorderedChatId}"]`,
      );
      await fixture.page.getByRole('button', { name: 'View', exact: true }).focus();
      await setLaneScroll(fixture, READY_COLUMN_ID, 0);
      await reorderedCard.waitFor({ state: 'detached' });

      markPhase('retaining an offscreen focus bookmark across the mobile host remount');
      await setLaneScroll(fixture, READY_COLUMN_ID, 1);
      const offscreenTransition = fixture.page.locator(
        `[data-chat-board-column-id="${READY_COLUMN_ID}"] [data-chat-board-chat-id="${reorderedChatId}"] [data-chat-board-focus-target="transition"]`,
      );
      await offscreenTransition.waitFor();
      await offscreenTransition.focus();
      const remountedReadyScrollTop = await setLaneScroll(fixture, READY_COLUMN_ID, 0);
      await fixture.page.setViewportSize({ width: 390, height: 600 });
      const mobilePanel = fixture.page.locator(
        '[data-chat-board-panel][data-presentation="mobile"][data-presentation-band="narrow"]',
      );
      await mobilePanel.waitFor();
      await expectLaneScroll(fixture, READY_COLUMN_ID, remountedReadyScrollTop);
      await expectTransitionFocus(fixture, READY_COLUMN_ID, reorderedChatId);

      markPhase('respecting new keyboard focus while desktop host restoration is pending');
      const focusReview = focusReviewDuringNextDesktopMount(fixture);
      await fixture.page.setViewportSize({ width: 1_440, height: 600 });
      await focusReview;
      await fixture.page
        .locator('[data-chat-board-panel]:not([data-presentation="mobile"])')
        .waitFor();
      await expectLaneScroll(fixture, READY_COLUMN_ID, remountedReadyScrollTop);
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);
      await fixture.page.waitForFunction(
        (reviewColumnId) =>
          document.activeElement?.matches(`[data-chat-board-lane-heading="${reviewColumnId}"]`) === true,
        REVIEW_COLUMN_ID,
      );

      markPhase('keeping long direct-agent labels within detailed tag rows');
      await fixture.page.getByRole('button', { name: 'View', exact: true }).click();
      await fixture.page.getByRole('menuitemradio', { name: 'Detailed', exact: true }).click();
      const agentTags = fixture.page
        .locator(`[data-chat-board-column-id="${READY_COLUMN_ID}"] [data-slot="chat-agent-tags"]`)
        .first();
      await agentTags.evaluate((element) => {
        const row = element as HTMLElement;
        row.style.width = '130.5px';
        row.style.flex = '0 0 auto';
      });
      await fixture.page.waitForFunction(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      const tagGeometry = await agentTags.evaluate((element) => {
        const row = element as HTMLElement;
        const agent = row.firstElementChild;
        const overflow = row.lastElementChild;
        if (!(agent instanceof HTMLElement) || !(overflow instanceof HTMLElement)) {
          throw new Error('Expected agent and overflow elements.');
        }
        return {
          rowBottom: row.getBoundingClientRect().bottom,
          overflowBottom: overflow.getBoundingClientRect().bottom,
          agentWhiteSpace: getComputedStyle(agent).whiteSpace,
        };
      });
      expect(tagGeometry.agentWhiteSpace).toBe('nowrap');
      expect(tagGeometry.overflowBottom).toBeLessThanOrEqual(tagGeometry.rowBottom + 0.1);

      markPhase('disabling decorative card movement under both reduced-motion controls');
      const card = fixture.page.locator('[data-chat-board-occurrence]').first();
      const panel = fixture.page.locator('[data-chat-board-panel]');
      await card.hover();
      await panel.evaluate((element) => element.classList.add('chat-board-reduce-motion'));
      expect(await card.evaluate((element) => getComputedStyle(element).translate)).toBe('none');
      await panel.evaluate((element) => element.classList.remove('chat-board-reduce-motion'));
      await fixture.page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await card.evaluate((element) => getComputedStyle(element).translate)).toBe('none');
      fixture.assertNoBrowserErrors();
    });
  });
});
