import { describe, expect, test } from 'bun:test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright';
import {
  parseReorderChatResponse,
  type ReorderChatResponse,
} from '../../../common/chat-order-contracts.js';
import {
  createIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB_BUILD_INDEX = join(REPO_ROOT, 'web', 'build', 'index.html');
const ARTIFACT_ROOT = join(REPO_ROOT, 'integration-tests', 'artifacts', 'chromium');
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

interface ChromiumFixture {
  integration: IntegrationFixture;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  browserErrors: string[];
  reorderExchanges: ReorderExchange[];
}

function isReorderRequest(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/chats/reorder';
}

async function createChromiumFixture(): Promise<ChromiumFixture> {
  await access(WEB_BUILD_INDEX);
  const integration = await createIntegrationFixture();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addInitScript(() => {
      const localSettingsKey = 'pref_local_settings';
      try {
        const stored = JSON.parse(globalThis.localStorage.getItem(localSettingsKey) ?? '{}');
        const snapshot =
          stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        globalThis.localStorage.setItem(
          localSettingsKey,
          JSON.stringify({ ...snapshot, allowDirectChats: true }),
        );
      } catch {
        globalThis.localStorage.setItem(
          localSettingsKey,
          JSON.stringify({ allowDirectChats: true }),
        );
      }
    });

    const page = await context.newPage();
    const browserErrors: string[] = [];
    const reorderExchanges: ReorderExchange[] = [];
    const exchangesByRequest = new Map<Request, ReorderExchange>();
    page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(`console.error: ${message.text()}`);
    });
    page.on('request', (request) => {
      if (!isReorderRequest(request)) return;
      const exchange: ReorderExchange = {
        request: {
          method: request.method(),
          url: request.url(),
          body: request.postData(),
        },
      };
      reorderExchanges.push(exchange);
      exchangesByRequest.set(request, exchange);
    });
    page.on('response', async (response) => {
      const exchange = exchangesByRequest.get(response.request());
      if (!exchange) return;
      exchange.response = {
        status: response.status(),
        body: await response.text().catch(() => null),
      };
    });

    return {
      integration,
      browser,
      context,
      page,
      browserErrors,
      reorderExchanges,
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await integration.dispose().catch(() => undefined);
    throw error;
  }
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
  );
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

async function writeDiagnostics(
  testName: string,
  fixture: ChromiumFixture,
  error: unknown,
): Promise<string> {
  const safeName = testName
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const prefix = join(ARTIFACT_ROOT, `${safeName || 'chromium'}-${Date.now()}`);
  await mkdir(dirname(prefix), { recursive: true });

  await fixture.page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => undefined);
  await writeFile(`${prefix}.html`, await fixture.page.content().catch(() => '')).catch(
    () => undefined,
  );
  await writeFile(
    `${prefix}.json`,
    JSON.stringify(
      {
        testName,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        url: fixture.page.url(),
        browserErrors: fixture.browserErrors,
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
        integration: fixture.integration.diagnostics(),
      },
      null,
      2,
    ),
  );
  return `${prefix}.json`;
}

async function disposeChromiumFixture(fixture: ChromiumFixture): Promise<void> {
  const errors: unknown[] = [];
  try {
    await fixture.context.close();
    await fixture.browser.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await fixture.integration.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Chromium fixture cleanup failed.');
}

async function withChromiumFixture<T>(
  testName: string,
  run: (fixture: ChromiumFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createChromiumFixture();
  let failure: unknown;
  try {
    return await run(fixture);
  } catch (error) {
    failure = error;
    const artifact = await writeDiagnostics(testName, fixture, error).catch(() => null);
    if (artifact && error instanceof Error) {
      error.message = `${error.message}\nChromium diagnostics: ${artifact}`;
    }
    throw error;
  } finally {
    try {
      await disposeChromiumFixture(fixture);
    } catch (disposeError) {
      if (failure === undefined) throw disposeError;
      console.error(disposeError);
    }
  }
}

describe('Chromium sidebar chat reorder', () => {
  test('persists inverse adjacent drags and leaves popup reorder usable', async () => {
    await withChromiumFixture('sidebar-chat-reorder', async (fixture) => {
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

      const up = await dragRelative(fixture.page, {
        sourceId,
        targetId: neighborId,
        edge: 'top',
      });
      const movedUp = [sourceId, neighborId, ...original.slice(2)];
      expect(up).toEqual({
        success: true,
        chatId: sourceId,
        orderGroup: 'normal',
        changed: true,
      });
      await waitForSidebarOrder(fixture.page, movedUp);
      expect(await normalOrder(fixture.integration)).toEqual(movedUp);

      const down = await dragRelative(fixture.page, {
        sourceId,
        targetId: neighborId,
        edge: 'bottom',
      });
      expect(down).toEqual({
        success: true,
        chatId: sourceId,
        orderGroup: 'normal',
        changed: true,
      });
      await waitForSidebarOrder(fixture.page, original);
      expect(await sidebarOrder(fixture.page)).toEqual(original);
      expect(await normalOrder(fixture.integration)).toEqual(original);
      expect(
        await fixture.page
          .locator(`[data-sidebar-virtual-row="${sourceId}"]`)
          .getAttribute('class'),
      ).not.toContain('opacity-45');
      expect(
        await fixture.page.locator(`${CHAT_ROW_SELECTOR} > div.pointer-events-none`).count(),
      ).toBe(0);

      const popupSourceId = original.at(-1);
      if (!popupSourceId) throw new Error('Expected a popup reorder source.');
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

      const movedToTop = [popupSourceId, ...original.filter((chatId) => chatId !== popupSourceId)];
      await waitForSidebarOrder(fixture.page, movedToTop);
      expect(await normalOrder(fixture.integration)).toEqual(movedToTop);
      expect(fixture.browserErrors).toEqual([]);
    });
  }, 60_000);
});
