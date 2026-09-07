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
      addTags: ['ready', 'review'],
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
): Promise<void> {
	const selector = `[data-chat-board-lane-list="${columnId}"]`;
	try {
		await fixture.page.waitForFunction(
			({ selector: laneSelector, scrollTop }) => {
				const element = document.querySelector<HTMLElement>(laneSelector);
				const tolerance = Math.max(12, scrollTop * 0.25);
				return element !== null && Math.abs(element.scrollTop - scrollTop) <= tolerance;
			},
			{ selector, scrollTop: expected },
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

describe('Chromium Chat Board interactions', () => {
  test('restores the invoking action and preserves lane scroll through responsive remounts', async () => {
    await withChromiumFixture('chat-board-responsive-interactions', async (fixture, markPhase) => {
      await fixture.page.setViewportSize({ width: 1_440, height: 600 });
      markPhase('seeding the board and overlapping cards');
      await seedBoard(fixture);
      const firstChatId = await seedChats(fixture, 8);

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

      markPhase('recording independent lane scroll positions');
      const readyScrollTop = await setLaneScroll(fixture, READY_COLUMN_ID, 0.4);
      const reviewScrollTop = await setLaneScroll(fixture, REVIEW_COLUMN_ID, 0.7);
      expect(readyScrollTop).toBeGreaterThan(0);
      expect(reviewScrollTop).toBeGreaterThan(0);

      markPhase('switching lanes after entering narrow presentation');
			await constrainBoardWidth(fixture, 480);
      await fixture.page.locator('[data-chat-board-panel][data-presentation-band="narrow"]').waitFor();
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);
      await fixture.page.getByRole('tab', { name: /Review 8/ }).click();
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);
      await fixture.page.getByRole('tab', { name: /Ready 8/ }).click();
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);

			markPhase('restoring both lanes after leaving narrow presentation');
			await constrainBoardWidth(fixture, null);
			await fixture.page
				.locator('[data-chat-board-panel]:not([data-presentation-band="narrow"])')
				.waitFor();
      await expectLaneScroll(fixture, READY_COLUMN_ID, readyScrollTop);
      await expectLaneScroll(fixture, REVIEW_COLUMN_ID, reviewScrollTop);
      fixture.assertNoBrowserErrors();
    });
  });
});
