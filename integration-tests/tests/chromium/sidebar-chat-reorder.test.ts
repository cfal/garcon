import { describe, expect, test } from 'bun:test';
import type { Page, Request } from 'playwright';
import {
  parseReorderChatRequest,
  parseReorderChatResponse,
  type ReorderChatRequest,
  type ReorderChatResponse,
} from '../../../common/chat-order-contracts.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import {
  withChromiumFixture,
  type ChromiumFixture as BaseChromiumFixture,
} from '../../support/chromium-fixture.js';

const CHAT_ROW_SELECTOR = '[data-sidebar-virtual-row][data-sidebar-virtual-list-row="normal"]';

interface ReorderExchange {
  request: {
    method: string;
    url: string;
    body: string | null;
  };
  response?: {
    status: number;
    body: string | null;
  };
}

interface ChromiumFixture extends BaseChromiumFixture {
  reorderExchanges: ReorderExchange[];
}

function isReorderRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/chats/reorder';
}

async function normalOrder(integration: IntegrationFixture): Promise<string[]> {
  return (await integration.client.listChats()).sessions
    .filter((chat) => chat.orderGroup === 'normal')
    .map((chat) => chat.id);
}

async function sidebarOrder(page: Page): Promise<string[]> {
  return page
    .locator(CHAT_ROW_SELECTOR)
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.sidebarVirtualRow ?? ''));
}

async function waitForSidebarOrder(page: Page, expected: string[]): Promise<void> {
  await page.waitForFunction(
    ({ selector, expectedOrder }) => {
      const actual = [...document.querySelectorAll<HTMLElement>(selector)].map(
        (row) => row.dataset.sidebarVirtualRow ?? '',
      );
      return (
        actual.length === expectedOrder.length &&
        actual.every((chatId, index) => chatId === expectedOrder[index])
      );
    },
    { selector: CHAT_ROW_SELECTOR, expectedOrder: expected },
    { timeout: 10_000 },
  );
}

function capturedReorderRequests(fixture: ChromiumFixture): ReorderChatRequest[] {
  return fixture.reorderExchanges.map(({ request }) => {
    const parsed = parseReorderChatRequest(request.body ? JSON.parse(request.body) : null);
    if (!parsed) throw new Error(`Invalid captured reorder request: ${request.body ?? '<empty>'}`);
    return parsed;
  });
}

async function dragRelative(
  page: Page,
  input: { sourceId: string; targetId: string; edge: 'top' | 'bottom' },
): Promise<ReorderChatResponse> {
  const source = page.locator(`[data-sidebar-virtual-row="${input.sourceId}"]`);
  const target = page.locator(`[data-sidebar-virtual-row="${input.targetId}"]`);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Missing sidebar drag geometry.');

  const responsePromise = page.waitForResponse((response) => isReorderRequest(response.request()), {
    timeout: 10_000,
  });
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height * (input.edge === 'top' ? 0.2 : 0.8),
    { steps: 12 },
  );
  await page.waitForTimeout(300);
  await page.mouse.up();

  const response = await responsePromise;
  const parsed = parseReorderChatResponse(await response.json());
  if (!parsed) throw new Error('Invalid chat reorder response.');
  return parsed;
}

function moveRelative(
  order: string[],
  input: { sourceId: string; targetId: string; position: 'before' | 'after' },
): string[] {
  const withoutSource = order.filter((chatId) => chatId !== input.sourceId);
  const targetIndex = withoutSource.indexOf(input.targetId);
  if (targetIndex === -1) throw new Error(`Missing relative reorder target: ${input.targetId}`);
  const insertionIndex = targetIndex + (input.position === 'after' ? 1 : 0);
  withoutSource.splice(insertionIndex, 0, input.sourceId);
  return withoutSource;
}

async function expectRelativeDrag(
  fixture: ChromiumFixture,
  currentOrder: string[],
  expectedRequests: ReorderChatRequest[],
  input: { sourceId: string; targetId: string; position: 'before' | 'after' },
): Promise<string[]> {
  const response = await dragRelative(fixture.page, {
    sourceId: input.sourceId,
    targetId: input.targetId,
    edge: input.position === 'before' ? 'top' : 'bottom',
  });
  expect(response).toEqual({
    success: true,
    chatId: input.sourceId,
    orderGroup: 'normal',
    changed: true,
  });

  expectedRequests.push({
    chatId: input.sourceId,
    placement: {
      kind: 'relative',
      referenceChatId: input.targetId,
      position: input.position,
    },
  });
  expect(capturedReorderRequests(fixture)).toEqual(expectedRequests);

  const expectedOrder = moveRelative(currentOrder, input);
  await waitForSidebarOrder(fixture.page, expectedOrder);
  expect(await sidebarOrder(fixture.page)).toEqual(expectedOrder);
  expect(await normalOrder(fixture.integration)).toEqual(expectedOrder);
  expect(
    await fixture.page
      .locator(`[data-sidebar-virtual-row="${input.sourceId}"]`)
      .getAttribute('class'),
  ).not.toContain('opacity-45');
  expect(
    await fixture.page.locator(`${CHAT_ROW_SELECTOR} > div.pointer-events-none`).count(),
  ).toBe(0);
  return expectedOrder;
}

async function startNewOpenAiChat(fixture: ChromiumFixture): Promise<string> {
  const content = 'native-drag-after-repeated-reorders';
  const existingIds = new Set(
    (await fixture.integration.client.listChats()).sessions.map((chat) => chat.id),
  );
  const eventCursor = fixture.integration.client.markEvents();

  await fixture.page.getByRole('button', { name: 'New Chat', exact: true }).click();
  const dialog = fixture.page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog
    .getByRole('status', { name: 'Loading chat defaults...' })
    .waitFor({ state: 'detached', timeout: 20_000 });

  const modelSelector = dialog.locator('button[aria-label*=" / "]').first();
  await modelSelector.waitFor({ state: 'visible' });
  const selectedModel = (await modelSelector.getAttribute('aria-label')) ?? '';
  if (
    !selectedModel.includes('Direct (Chat Completions)') ||
    !selectedModel.includes('Integration Echo')
  ) {
    await modelSelector.click();
    await fixture.page.getByRole('button', { name: 'Chat Completions', exact: true }).click();
    await fixture.page.getByRole('button', { name: 'Integration Echo', exact: true }).click();
  }

  const projectPathInput = dialog.getByRole('textbox', { name: 'Project Path' });
  if ((await projectPathInput.inputValue()) !== fixture.integration.dirs.project) {
    await projectPathInput.fill(fixture.integration.dirs.project);
  }
  await dialog.getByPlaceholder('How can I help you today?').fill(content);

  await fixture.page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
        .find((candidate) => (
          candidate.getAttribute('aria-label') || candidate.textContent?.trim()
        ) === 'Start session');
      return button !== undefined && !button.disabled;
    },
    undefined,
    { timeout: 20_000 },
  );
  const newChatPath = fixture.page.waitForFunction(
    (knownChatIds) => {
      const match = /^\/chat\/([^/]+)$/.exec(globalThis.location.pathname);
      if (!match?.[1]) return null;
      const chatId = decodeURIComponent(match[1]);
      return knownChatIds.includes(chatId) ? null : chatId;
    },
    [...existingIds],
    { timeout: 20_000 },
  );
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  const chatId = await (await newChatPath).jsonValue();
  if (typeof chatId !== 'string') throw new Error(`Missing new chat ID in URL: ${fixture.page.url()}`);
  await fixture.integration.client.waitForTurnTerminal(chatId, undefined, {
    afterIndex: eventCursor,
    timeoutMs: 20_000,
  });
  await dialog.waitFor({ state: 'detached' });
  return chatId;
}

async function createChats(integration: IntegrationFixture, count: number): Promise<string[]> {
  const chatIds = Array.from({ length: count }, () => integration.newChatId());
  for (const [index, chatId] of chatIds.entries()) {
    const started = await integration.client.startDirectChat({
      chatId,
      content: `native-drag-${index}`,
      projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
  }
  return chatIds;
}

async function withSidebarChromiumFixture<T>(
  testName: string,
  run: (fixture: ChromiumFixture) => Promise<T>,
): Promise<T> {
  return withChromiumFixture(
    testName,
    async (baseFixture) => {
      const fixture = Object.assign(baseFixture, {
        reorderExchanges: [] as ReorderExchange[],
      });
      const exchangesByRequest = new Map<Request, ReorderExchange>();
      fixture.page.on('request', (request) => {
        if (!isReorderRequest(request)) return;
        const exchange: ReorderExchange = {
          request: {
            method: request.method(),
            url: request.url(),
            body: request.postData(),
          },
        };
        fixture.reorderExchanges.push(exchange);
        exchangesByRequest.set(request, exchange);
      });
      fixture.page.on('response', async (response) => {
        const exchange = exchangesByRequest.get(response.request());
        if (!exchange) return;
        exchange.response = {
          status: response.status(),
          body: await response.text().catch(() => null),
        };
      });
      return run(fixture);
    },
    async (baseFixture) => {
      const fixture = baseFixture as ChromiumFixture;
      return {
        reorderExchanges: fixture.reorderExchanges,
        sidebarOrder: await sidebarOrder(fixture.page).catch(() => []),
        serverOrder: await normalOrder(fixture.integration).catch(() => []),
        dimmedRows: await fixture.page
          .locator(`${CHAT_ROW_SELECTOR}.opacity-45`)
          .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.sidebarVirtualRow))
          .catch(() => []),
        dropIndicatorCount: await fixture.page
          .locator(`${CHAT_ROW_SELECTOR} > div.pointer-events-none`)
          .count()
          .catch(() => -1),
      };
    },
  );
}

describe('Chromium sidebar chat reorder', () => {
  test('survives repeated inverse drags, chat creation, and subsequent reorder actions', async () => {
    await withSidebarChromiumFixture('sidebar-chat-reorder', async (fixture) => {
      // Drag reorder is only enabled under manual sidebar sort.
      await fixture.page.addInitScript(() => {
        const key = 'pref_local_settings';
        try {
          const stored = JSON.parse(globalThis.localStorage.getItem(key) ?? '{}');
          const snapshot =
            stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
          globalThis.localStorage.setItem(
            key,
            JSON.stringify({ ...snapshot, sidebarSortMode: 'manual' }),
          );
        } catch {
          globalThis.localStorage.setItem(key, JSON.stringify({ sidebarSortMode: 'manual' }));
        }
      });
      const chatIds = await createChats(fixture.integration, 4);
      const original = await normalOrder(fixture.integration);
      expect(original).toHaveLength(chatIds.length);

      const response = await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatIds[0])}`,
        { waitUntil: 'domcontentloaded' },
      );
      if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
      await waitForSidebarOrder(fixture.page, original);

      const sourceId = original[1];
      const neighborId = original[0];
      if (!sourceId || !neighborId) throw new Error('Expected two normal chats.');
      const expectedRequests: ReorderChatRequest[] = [];
      let expectedOrder = original;
      for (const position of ['before', 'after', 'before', 'after', 'before'] as const) {
        expectedOrder = await expectRelativeDrag(fixture, expectedOrder, expectedRequests, {
          sourceId,
          targetId: neighborId,
          position,
        });
      }

      const orderBeforeNewChat = expectedOrder;
      const newChatId = await startNewOpenAiChat(fixture);
      expectedOrder = await normalOrder(fixture.integration);
      expect(expectedOrder).toHaveLength(original.length + 1);
      expect(expectedOrder.filter((chatId) => chatId !== newChatId)).toEqual(orderBeforeNewChat);
      await waitForSidebarOrder(fixture.page, expectedOrder);

      const newChatIndex = expectedOrder.indexOf(newChatId);
      if (newChatIndex === -1) throw new Error('New chat did not enter the normal order.');
      const moveNewChatDown = newChatIndex < expectedOrder.length - 1;
      const newChatNeighbor = expectedOrder[newChatIndex + (moveNewChatDown ? 1 : -1)];
      if (!newChatNeighbor) throw new Error('New chat does not have an adjacent reorder target.');
      expectedOrder = await expectRelativeDrag(fixture, expectedOrder, expectedRequests, {
        sourceId: newChatId,
        targetId: newChatNeighbor,
        position: moveNewChatDown ? 'after' : 'before',
      });

      const popupSourceId = expectedOrder.at(-1);
      if (!popupSourceId) throw new Error('Expected a popup reorder source.');
      const popupReferenceId = expectedOrder[0];
      if (!popupReferenceId) throw new Error('Expected a popup reorder reference.');
      const popupRow = fixture.page.locator(`[data-sidebar-virtual-row="${popupSourceId}"]`);
      await popupRow.hover();
      await popupRow
        .locator('[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]')
        .click();
      const moveToTop = fixture.page.getByRole('menuitem', {
        name: 'Move to top',
        exact: true,
      });
      await moveToTop.waitFor();
      const popupResponsePromise = fixture.page.waitForResponse(
        (popupResponse) => isReorderRequest(popupResponse.request()),
        { timeout: 10_000 },
      );
      await moveToTop.click();
      const popupResponse = parseReorderChatResponse(await (await popupResponsePromise).json());
      expect(popupResponse).toEqual({
        success: true,
        chatId: popupSourceId,
        orderGroup: 'normal',
        changed: true,
      });
      expectedRequests.push({
        chatId: popupSourceId,
        placement: {
          kind: 'relative',
          referenceChatId: popupReferenceId,
          position: 'before',
        },
      });
      expect(capturedReorderRequests(fixture)).toEqual(expectedRequests);

      const movedToTop = [
        popupSourceId,
        ...expectedOrder.filter((chatId) => chatId !== popupSourceId),
      ];
      await waitForSidebarOrder(fixture.page, movedToTop);
      expect(await normalOrder(fixture.integration)).toEqual(movedToTop);
      expect(fixture.browserErrors).toEqual([]);
    });
  }, 120_000);
});
