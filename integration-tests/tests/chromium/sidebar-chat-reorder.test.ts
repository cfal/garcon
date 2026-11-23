import { describe, expect, test } from 'bun:test';
import type { Page, Request } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseReorderChatRequest,
  parseReorderChatResponse,
  parseSortChatOrderRequest,
  parseSortChatOrderResponse,
  type ReorderChatRequest,
  type ReorderChatResponse,
  type SortChatOrderRequest,
  type SortChatOrderResponse,
} from '../../../common/chat-order-contracts.js';
import {
  compareChatOrderNewestFirst,
  type ChatOrderSortKey,
} from '../../../common/chat-order-sort.js';
import type { IntegrationFixture } from '../../support/integration-fixture.js';
import {
  withChromiumFixture,
  type ChromiumFixture as BaseChromiumFixture,
} from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { createSidebarDelegationFixture } from '../../support/sidebar-delegation-fixture.js';

const CHAT_ROW_SELECTOR = '[data-sidebar-virtual-row][data-sidebar-virtual-list-row="normal"]';

interface OrderExchange {
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
  reorderExchanges: OrderExchange[];
  sortExchanges: OrderExchange[];
}

function isReorderRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/chats/reorder';
}

function isSortRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/chats/sort';
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

function capturedSortRequests(fixture: ChromiumFixture): SortChatOrderRequest[] {
  return fixture.sortExchanges.map(({ request }) => {
    const parsed = parseSortChatOrderRequest(request.body ? JSON.parse(request.body) : null);
    if (!parsed) throw new Error(`Invalid captured sort request: ${request.body ?? '<empty>'}`);
    return parsed;
  });
}

async function expectedNormalOrder(
  integration: IntegrationFixture,
  sortKey: ChatOrderSortKey,
): Promise<string[]> {
  const compare = compareChatOrderNewestFirst(sortKey);
  return (await integration.client.listChats()).sessions
    .filter((chat) => chat.orderGroup === 'normal')
    .map((chat) => ({
      id: chat.id,
      createdAt: chat.activity.createdAt,
      lastActivityAt: chat.activity.lastActivityAt,
    }))
    .sort(compare)
    .map((chat) => chat.id);
}

async function sortFromChatMenu(
  fixture: ChromiumFixture,
  chatId: string,
  label: 'By creation time' | 'By recent activity',
): Promise<SortChatOrderResponse> {
  const row = fixture.page.locator(`[data-sidebar-virtual-row="${chatId}"]`);
  await row.hover();
  await row.locator('[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]').click();
  const reorderChats = fixture.page.getByRole('menuitem', { name: 'Reorder all chats', exact: true });
  await reorderChats.click();
  const preset = fixture.page.getByRole('menuitem', { name: label, exact: true });
  await preset.waitFor();
  const responsePromise = fixture.page.waitForResponse(
    (response) => isSortRequest(response.request()),
    { timeout: 10_000 },
  );
  await preset.click();
  const parsed = parseSortChatOrderResponse(await (await responsePromise).json());
  if (!parsed) throw new Error('Invalid chat order sort response.');
  return parsed;
}

async function dragRelative(
  page: Page,
  input: { sourceId: string; targetId: string; edge: 'top' | 'bottom' },
): Promise<ReorderChatResponse> {
  const source = page.locator(`[data-sidebar-virtual-row="${input.sourceId}"]`);
  const target = page.locator(`[data-sidebar-virtual-row="${input.targetId}"]`);
  // Menu dismissal can leave the body pointer-locked after the rows update.
  await source.hover();
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error('Missing sidebar drag geometry.');

  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height * (input.edge === 'top' ? 0.2 : 0.8),
    { steps: 12 },
  );
  await page.locator(`[data-sidebar-virtual-row="${input.sourceId}"].opacity-45`).waitFor();
  await page.locator('[data-sidebar-branch-drop-indicator]').waitFor();
  const [response] = await Promise.all([
    page.waitForResponse((response) => isReorderRequest(response.request()), { timeout: 10_000 }),
    page.mouse.up(),
  ]);

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
    await fixture.page.locator('[data-sidebar-branch-drop-indicator]').count(),
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

  const modelSelector = dialog.locator('[data-slot="model-selector-trigger"]');
  await modelSelector.waitFor({ state: 'visible' });
  const selectedModel = (await modelSelector.getAttribute('title')) ?? '';
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
        reorderExchanges: [] as OrderExchange[],
        sortExchanges: [] as OrderExchange[],
      });
      const exchangesByRequest = new Map<Request, OrderExchange>();
      fixture.page.on('request', (request) => {
        let exchanges: OrderExchange[];
        if (isReorderRequest(request)) {
          exchanges = fixture.reorderExchanges;
        } else if (isSortRequest(request)) {
          exchanges = fixture.sortExchanges;
        } else {
          return;
        }
        const exchange: OrderExchange = {
          request: {
            method: request.method(),
            url: request.url(),
            body: request.postData(),
          },
        };
        exchanges.push(exchange);
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
        sortExchanges: fixture.sortExchanges,
        bodyPointerEvents: await fixture.page.evaluate(() => getComputedStyle(document.body).pointerEvents).catch(() => null),
        sidebarOrder: await sidebarOrder(fixture.page).catch(() => []),
        serverOrder: await normalOrder(fixture.integration).catch(() => []),
        dimmedRows: await fixture.page
          .locator(`${CHAT_ROW_SELECTOR}.opacity-45`)
          .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.sidebarVirtualRow))
          .catch(() => []),
        dropIndicatorCount: await fixture.page
          .locator('[data-sidebar-branch-drop-indicator]')
          .count()
          .catch(() => -1),
      };
    },
  );
}

describe('Chromium sidebar chat reorder', () => {
  test('keeps native dragging alive across filtered context rows', async () => {
    await withSidebarChromiumFixture('sidebar-filtered-context-reorder', async (fixture) => {
      const { page, integration } = fixture;
      await page.addInitScript(seedLocalSettings, {
        sidebarSortMode: 'manual',
        sidebarNestDelegatedChats: false,
      });
      const { a, b, b1 } = await createSidebarDelegationFixture(integration);
      const c = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId: c, projectPath: integration.dirs.project,
        content: 'Synthetic independent root', agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(c, started.turnId);
      for (const [id, title] of [[a, 'matchedsidebar a'], [b, 'Context parent'], [b1, 'matchedsidebar child'], [c, 'matchedsidebar c']] as const) {
        await integration.client.updateSessionName(id, title);
      }
      for (const id of [a, b, c]) {
        await integration.client.reorderChat({ chatId: id, placement: { kind: 'boundary', boundary: 'bottom' } });
      }
      await page.goto(`${integration.garcon.baseUrl}/chat/${a}`);
      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Sidebar display', exact: true }).click();
      const nesting = page.getByRole('checkbox', { name: 'Nest delegated chats', exact: true });
      expect(await nesting.isChecked()).toBe(false);
      await nesting.click();
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await page.getByRole('button', { name: 'Search chats...', exact: true }).click();
      const search = page.getByRole('dialog', { name: 'Search chats...', exact: true }).getByRole('textbox');
      await search.fill('matchedsidebar');
      await search.press('Enter');
      await waitForSidebarOrder(page, [a, b, b1, c]);
      const row = (id: string) => page.locator(`[data-sidebar-virtual-row="${id}"]`);
      const source = (await row(c).boundingBox())!;
      const blocked = (await row(b).boundingBox())!;
      const target = (await row(a).boundingBox())!;
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(blocked.x + blocked.width / 2, blocked.y + blocked.height / 2, { steps: 12 });
      await page.waitForTimeout(300);
      expect(await page.locator('[data-sidebar-branch-drop-indicator]').count()).toBe(0);
      expect(await sidebarOrder(page)).toEqual([a, b, b1, c]);
      await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.2, { steps: 12 });
      await page.waitForSelector('[data-sidebar-branch-drop-indicator]');
      const response = page.waitForResponse(response => isReorderRequest(response.request()));
      await page.mouse.up();
      expect((await response).ok()).toBe(true);
      await waitForSidebarOrder(page, [c, a, b, b1]);
      expect(capturedReorderRequests(fixture)).toEqual([{
        chatId: c, placement: { kind: 'relative', referenceChatId: a, position: 'before' },
      }]);
      for (const edge of ['top', 'bottom'] as const) {
        for (const id of [a, b, c]) {
          await integration.client.reorderChat({ chatId: id, placement: { kind: 'boundary', boundary: 'bottom' } });
        }
        await waitForSidebarOrder(page, [a, b, b1, c]);
        const sourceId = edge === 'top' ? a : c;
        const targetId = edge === 'top' ? c : a;
        await dragRelative(page, { sourceId, targetId, edge });
        await waitForSidebarOrder(page, edge === 'top' ? [b, b1, a, c] : [a, c, b, b1]);
        expect(capturedReorderRequests(fixture).at(-1)).toEqual({
          chatId: sourceId,
          placement: { kind: 'relative', referenceChatId: targetId, position: edge === 'top' ? 'before' : 'after' },
        });
      }
      expect(capturedReorderRequests(fixture)).toHaveLength(3);
      expect(fixture.browserErrors).toEqual([]);
    });
  }, 120_000);

  test('moves whole delegated branches with one root request and retains nested priority after reload', async () => {
    await withSidebarChromiumFixture('sidebar-delegated-reorder', async (fixture) => {
      const { page, integration } = fixture;
      await page.addInitScript(seedLocalSettings, {
        sidebarSortMode: 'manual',
        sidebarNestDelegatedChats: true,
      });
      const { a, b, a1, a2, b1, canonical } = await createSidebarDelegationFixture(integration);
      await page.goto(`${integration.garcon.baseUrl}/chat/${a}`);
      await waitForSidebarOrder(page, [b, b1, a, a1, a2]);
      const parentBounds = await page
        .locator(`[data-sidebar-virtual-row="${a}"] [data-slot="chat-summary-header"]`)
        .boundingBox();
      const childBounds = await page
        .locator(`[data-sidebar-virtual-row="${a1}"] [data-slot="chat-summary-header"]`)
        .boundingBox();
      expect(childBounds!.x).toBeGreaterThan(parentBounds!.x);
      await dragRelative(page, { sourceId: b, targetId: a, edge: 'bottom' });
      await waitForSidebarOrder(page, [a, a1, a2, b, b1]);
      expect(await normalOrder(integration)).toEqual([a1, a, b, b1, a2]);
      expect(capturedReorderRequests(fixture)).toEqual([
        {
          chatId: b,
          placement: {
            kind: 'relative',
            referenceChatId: a,
            position: 'after',
          },
        },
      ]);
      expect((await normalOrder(integration)).filter((id) => id !== b)).toEqual(
        canonical.filter((id) => id !== b),
      );

      await dragRelative(page, { sourceId: a2, targetId: a1, edge: 'top' });
      await waitForSidebarOrder(page, [a, a2, a1, b, b1]);
      await page.reload();
      await waitForSidebarOrder(page, [a, a2, a1, b, b1]);

      const aRow = page.locator(`[data-sidebar-virtual-row="${a}"]`);
      await page
        .locator(`[data-sidebar-virtual-row="${a1}"] [data-slot="chat-summary-header"]`)
        .click();
      await aRow.locator('[data-slot="chat-summary-header"]').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Collapse delegated chats', exact: true }).click();
      await waitForSidebarOrder(page, [a, b, b1]);
      expect(await aRow.locator('.chat-item-root .bg-sidebar-chat-item-selected-bg').count()).toBe(
        1,
      );
      expect(await aRow.locator('[aria-current="page"]').count()).toBe(0);
      await dragRelative(page, { sourceId: a, targetId: b, edge: 'bottom' });
      await waitForSidebarOrder(page, [b, b1, a]);
      await aRow.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Expand delegated chats', exact: true }).click();
      await waitForSidebarOrder(page, [b, b1, a, a2, a1]);
      expect(capturedReorderRequests(fixture).map((request) => request.chatId)).toEqual([b, a2, a]);
      const beforeInvalid = await normalOrder(integration);
      await page
        .locator(`[data-sidebar-virtual-row="${a1}"]`)
        .dragTo(page.locator(`[data-sidebar-virtual-row="${b1}"]`));
      expect(await normalOrder(integration)).toEqual(beforeInvalid);
      expect(capturedReorderRequests(fixture)).toHaveLength(3);

      await page.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Recent activity', exact: true }).click();
      const cursor = integration.client.markEvents();
      const turn = await integration.client.runDirectChat({
        chatId: a1,
        content: 'Synthetic recent branch update',
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(a1, turn.turnId, {
        afterIndex: cursor,
      });
      await waitForSidebarOrder(page, [a, a1, a2, b, b1]);
      expect(await normalOrder(integration)).toEqual(beforeInvalid);
      const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
      await mkdir(artifacts, { recursive: true });
      const assertInternalIndentation = async () => {
        const geometry = await page.locator(CHAT_ROW_SELECTOR).evaluateAll((rows) => rows.map(row => {
          const button = row.querySelector<HTMLButtonElement>('.chat-item-root button')!;
          const bounds = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          return {
            id: row.getAttribute('data-sidebar-virtual-row'),
            leftInset: bounds.left - row.getBoundingClientRect().left,
            width: bounds.width,
            leftPadding: style.paddingLeft,
            rightPadding: style.paddingRight,
          };
        }));
        const parent = geometry.find(row => row.id === a)!;
        const child = geometry.find(row => row.id === a2)!;
        expect(parent.leftPadding).toBe('12px');
        expect(child.leftPadding).toBe('24px');
        expect(parent.rightPadding).toBe('8px');
        expect(child.rightPadding).toBe('8px');
        expect(parent.leftInset).toBe(0);
        expect(child.leftInset).toBe(0);
        expect(child.width).toBe(parent.width);
        expect(await page.locator(`${CHAT_ROW_SELECTOR} > [data-sidebar-virtual-row-content] > button`).count()).toBe(0);
        const button = page.locator(`[data-sidebar-virtual-row="${a2}"] .chat-item-root button`).first();
        await page.mouse.move(385, 5);
        const beforeHover = await button.evaluate(el => getComputedStyle(el).backgroundColor);
        await button.hover({ position: { x: 4, y: 10 } });
        await page.waitForFunction(({ id, before }) => {
          const el = document.querySelector(`[data-sidebar-virtual-row="${id}"] .chat-item-root button`)!;
          return el.matches(':hover') && getComputedStyle(el).backgroundColor !== before;
        }, { id: a2, before: beforeHover });
      };
      await assertInternalIndentation();
      await page.screenshot({
        path: join(artifacts, 'sidebar-branches-desktop.png'),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForSelector('.mobile-shell');
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await waitForSidebarOrder(page, [a, a1, a2, b, b1]);
      await assertInternalIndentation();
      await aRow.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Collapse delegated chats', exact: true }).click();
      await waitForSidebarOrder(page, [a, b, b1]);
      await aRow.getByRole('button', { name: 'Chat actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Expand delegated chats', exact: true }).click();
      await waitForSidebarOrder(page, [a, a1, a2, b, b1]);
      await page.screenshot({
        path: join(artifacts, 'sidebar-branches-mobile.png'),
      });
      expect(fixture.browserErrors).toEqual([]);
    });
  }, 120_000);

  test('survives repeated inverse drags, chat creation, and subsequent reorder actions', async () => {
    await withSidebarChromiumFixture('sidebar-chat-reorder', async (fixture) => {
      // Drag reorder is only enabled under manual sidebar sort.
      await fixture.page.addInitScript(seedLocalSettings, {
        sidebarSortMode: 'manual',
        sidebarNestDelegatedChats: false,
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

      const creationOrder = await expectedNormalOrder(fixture.integration, 'created');
      const creationResponse = await sortFromChatMenu(
        fixture,
        movedToTop[0]!,
        'By creation time',
      );
      expect(creationResponse).toEqual({
        success: true,
        sortKey: 'created',
        changed: true,
      });
      expect(capturedSortRequests(fixture)).toEqual([{ sortKey: 'created' }]);
      await fixture.page.getByText('Chats reordered.', { exact: true }).waitFor();
      await waitForSidebarOrder(fixture.page, creationOrder);
      expect(await normalOrder(fixture.integration)).toEqual(creationOrder);

      const activitySourceId = creationOrder.at(-1);
      if (!activitySourceId) throw new Error('Expected an activity sort source.');
      const eventCursor = fixture.integration.client.markEvents();
      const continued = await fixture.integration.client.runDirectChat({
        chatId: activitySourceId,
        content: 'activity-sort-follow-up',
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(activitySourceId, continued.turnId, {
        afterIndex: eventCursor,
      });
      const activityOrder = await expectedNormalOrder(fixture.integration, 'activity');
      expect(activityOrder).not.toEqual(creationOrder);

      const activityResponse = await sortFromChatMenu(
        fixture,
        creationOrder[0]!,
        'By recent activity',
      );
      expect(activityResponse).toEqual({
        success: true,
        sortKey: 'activity',
        changed: true,
      });
      expect(capturedSortRequests(fixture)).toEqual([
        { sortKey: 'created' },
        { sortKey: 'activity' },
      ]);
      await waitForSidebarOrder(fixture.page, activityOrder);
      expect(await normalOrder(fixture.integration)).toEqual(activityOrder);

      await fixture.page.getByRole('button', { name: 'More actions', exact: true }).click();
      await fixture.page.getByRole('menuitemradio', { name: 'Recent activity', exact: true }).click();
      const recentRow = fixture.page.locator(CHAT_ROW_SELECTOR).first();
      await recentRow.hover();
      await recentRow
        .locator('[data-slot="dropdown-menu-trigger"][aria-label="Chat actions"]')
        .click();
      await fixture.page.getByRole('menuitem', { name: 'Select', exact: true }).waitFor();
      expect(
        await fixture.page.getByRole('menuitem', { name: 'Reorder all chats', exact: true }).count(),
      ).toBe(0);
      expect(fixture.browserErrors).toEqual([]);
    });
  }, 120_000);
});
