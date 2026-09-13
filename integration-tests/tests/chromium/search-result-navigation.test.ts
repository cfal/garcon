import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { ThinkingMessage } from '../../../common/chat-types.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import type { Page, Route } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import {
  canonicalFilesWindowId,
  collapseCanonicalFilesWindow,
} from '../../support/chromium-workspace.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { createSearchNavigationTarget } from '../../support/search-navigation-fixture.js';
import type { ChatSearchNavigateRequest } from '../../../common/chat-search.js';

async function openSearch(page: Page, marker: string, mobile = false) {
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Search chats...', exact: true }).click();
  await page.getByPlaceholder('Search chats...', { exact: true }).fill(marker);
  await page
    .locator('[data-slot="transcript-search-snippet"]')
    .filter({ hasText: marker })
    .waitFor();
}

async function selectResult(page: Page) {
  await page.locator('[data-slot="search-dialog-results"] [role="option"]').click();
}

async function releaseRequest(page: Page, route: Route) {
  await route.continue();
  const response = await withTimeout(
    route.request().response(),
    20_000,
    () => 'Held request did not settle',
  );
  if (response) await response.finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function expectTargetVisible(page: Page, target: ChatSearchNavigateRequest) {
  await page.waitForFunction(({ transcriptViewId, ordinal }) => {
    const row = document.querySelector(`[data-chat-row-id="${transcriptViewId}:${ordinal}"]`);
    const viewport = row?.closest('[data-chat-scroll-viewport]');
    if (!row || !viewport) return false;
    const box = row.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return box.height > 0 && box.top >= bounds.top && box.bottom <= bounds.bottom;
  }, target);
}

for (const activation of ['click', 'Enter'] as const) {
  test(`shortcut search hands titlebar focus to the selected row via ${activation}`, async () => {
    await withChromiumFixture(
      `search-result-focus-${activation}`,
      async ({ page, integration, assertNoBrowserErrors }) => {
        const first = await createSearchNavigationTarget(integration, 'syntheticfocusfirst');
        const second = await createSearchNavigationTarget(integration, 'syntheticfocussecond');
        await page.goto(`${integration.garcon.baseUrl}/chat/${first.chatId}`);
        await collapseCanonicalFilesWindow(page);
        await page.locator('[data-workspace-window-titlebar]').click();
        await page.keyboard.press('Control+s');
        const input = page.getByPlaceholder('Search chats...', { exact: true });
        await input.fill(second.marker);
        await page
          .locator('[data-slot="transcript-search-snippet"]')
          .filter({ hasText: second.marker })
          .waitFor();
        if (activation === 'click') await selectResult(page);
        else await input.press('Enter');
        await expectTargetVisible(page, second.target);
        await page.waitForURL(`**/chat/${second.chatId}`);
        assertNoBrowserErrors();
      },
    );
  });
}

for (const width of [1440, 390]) {
  test(`search jumps to cold and same-chat old hits without moving the composer at ${width}px`, async () => {
    await withChromiumFixture(
      `search-result-exact-${width}`,
      async ({ page, integration, assertNoBrowserErrors }) => {
        const { target, marker, chatId } = await createSearchNavigationTarget(integration);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(integration.garcon.baseUrl);
        if (width > 700) await collapseCanonicalFilesWindow(page);
        const reads: URL[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname === '/api/v1/chats/messages' && url.searchParams.has('beforeOrdinal'))
            reads.push(url);
        });
        await openSearch(page, marker, width < 700);
        await selectResult(page);
        await expectTargetVisible(page, target);
        await page.waitForURL(`**/chat/${chatId}`);
        expect(reads).toHaveLength(1);
        expect(reads[0]!.searchParams.get('beforeOrdinal')).toBe(String(target.ordinal + 1));
        expect(reads[0]!.searchParams.get('transcriptViewId')).toBe(target.transcriptViewId);
        const composer = page.locator('textarea:visible');
        await composer.fill('Synthetic retained search draft.');
        const bounds = await composer.boundingBox();
        await openSearch(page, marker, width < 700);
        await page.getByPlaceholder('Search chats...', { exact: true }).press('Enter');
        await expectTargetVisible(page, target);
        expect(await composer.inputValue()).toBe('Synthetic retained search draft.');
        expect(await composer.boundingBox()).toEqual(bounds);
        await page.screenshot({ path: `artifacts/search-result-${width}.png` });
        assertNoBrowserErrors();
      },
    );
  });
}

for (const phase of ['validation', 'page'] as const) {
  test(`reload during search ${phase} never reuses the old ordinal`, async () => {
    await withChromiumFixture(
      `search-result-reload-${phase}`,
      async ({ page, context, integration, browserErrors }) => {
        const { target, marker, chatId } = await createSearchNavigationTarget(integration);
        const captured = new Deferred<Route>();
        await context.route(
          phase === 'validation' ? '**/api/v1/chats/search/navigate' : '**/api/v1/chats/messages?*',
          async (route) => {
            const query = new URL(route.request().url()).searchParams;
            if (
              (phase === 'validation' ||
                query.get('beforeOrdinal') === String(target.ordinal + 1)) &&
              captured.resolve(route)
            )
              return;
            await route.continue();
          },
        );
        await page.goto(integration.garcon.baseUrl);
        await collapseCanonicalFilesWindow(page);
        await openSearch(page, marker);
        await selectResult(page);
        const route = await withTimeout(
          captured.promise,
          20_000,
          () => 'Missing held search request',
        );
        try {
          const replacement = await integration.client.reloadChat(chatId);
          expect(replacement.transcriptViewId).not.toBe(target.transcriptViewId);
        } finally {
          await route.continue();
        }
        await page
          .getByText('Transcript was reloaded; search results refreshed.', {
            exact: true,
          })
          .waitFor();
        expect(
          await page
            .locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`)
            .count(),
        ).toBe(0);
        expect(browserErrors.filter((error) => !error.includes('409 (Conflict)'))).toEqual([]);
      },
    );
  });
}

for (const selection of ['search', 'sidebar'] as const) {
  test(`a held search page cannot steal focus after newer ${selection} selections`, async () => {
    await withChromiumFixture(
      `search-result-switch-${selection}`,
      async ({ page, integration, assertNoBrowserErrors }) => {
        const first = await createSearchNavigationTarget(integration, 'syntheticfirstmarker');
        const second = await createSearchNavigationTarget(integration, 'syntheticsecondmarker');
        await page.goto(integration.garcon.baseUrl);
        await collapseCanonicalFilesWindow(page);
        const captured = new Deferred<Route>();
        await page.route('**/api/v1/chats/messages?*', async (route) => {
          const query = new URL(route.request().url()).searchParams;
          if (
            query.get('chatId') === first.chatId &&
            query.get('beforeOrdinal') === String(first.target.ordinal + 1) &&
            captured.resolve(route)
          )
            return;
          await route.continue();
        });
        await openSearch(page, first.marker);
        await selectResult(page);
        const route = await withTimeout(
          captured.promise,
          20_000,
          () => 'Missing old search target request',
        );
        try {
          if (selection === 'search') {
            await openSearch(page, second.marker);
            await selectResult(page);
            await expectTargetVisible(page, second.target);
          } else {
            await page
              .locator('[data-slot="active-search-banner"]')
              .getByRole('button', { name: 'Clear search', exact: true })
              .click();
            for (const chatId of [second.chatId, first.chatId, second.chatId]) {
              await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
            }
            await page.locator(`[data-conversation-panel-chat-id="${second.chatId}"]`).waitFor();
          }
          const composer = page.locator('textarea:visible');
          await composer.fill('Synthetic newer draft.');
          const bounds = await composer.boundingBox();
          await releaseRequest(page, route);
          expect(await composer.inputValue()).toBe('Synthetic newer draft.');
          expect(await composer.boundingBox()).toEqual(bounds);
          expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
          if (selection === 'search') await expectTargetVisible(page, second.target);
          await page.waitForURL(`**/chat/${second.chatId}`);
          assertNoBrowserErrors();
        } finally {
          await route.continue().catch(() => undefined);
        }
      },
    );
  });
}

test('search uses the existing chat panel in a different split window', async () => {
  await withChromiumFixture(
    'search-result-split',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const { target, marker, chatId } = await createSearchNavigationTarget(integration);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const panel = page.locator(`[data-conversation-panel-chat-id="${chatId}"]`);
      await panel.waitFor();
      const surfaceId = await panel.getAttribute('data-conversation-panel');
      const composer = page.getByPlaceholder('Reply...', { exact: true });
      await composer.fill('Synthetic split draft.');
      const bounds = await composer.boundingBox();
      const filesWindow = await canonicalFilesWindowId(page);
      await page.locator(`[data-workspace-window-titlebar="${filesWindow}"]`).focus();
      await page.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-workspace-window-id="${id}"]`)
            ?.getAttribute('data-workspace-window-current') === 'true',
        filesWindow,
      );
      await openSearch(page, marker);
      await selectResult(page);
      await expectTargetVisible(page, target);
      expect(await panel.getAttribute('data-conversation-panel')).toBe(surfaceId);
      expect(await page.locator('[data-workspace-window-id]').count()).toBe(2);
      expect(await composer.inputValue()).toBe('Synthetic split draft.');
      expect(await composer.boundingBox()).toEqual(bounds);
      assertNoBrowserErrors();
    },
  );
});

test('search reports a hidden thinking row rather than claiming a visible jump', async () => {
  await withChromiumFixture(
    'search-result-hidden',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId,
        content: 'Synthetic reasoning search.',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await integration.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      const marker = 'synthetichiddenthinking';
      await integration.restartGarcon({
        beforeStart: async () => {
          const ledger = new TranscriptLedgerStore(
            join(integration.dirs.workspace, 'transcript-ledgers'),
          );
          try {
            const view = ledger.currentView(chatId);
            if (!view) throw new Error('Missing synthetic chat view');
            const at = '2026-01-01T00:00:00.000Z';
            ledger.append(chatId, view.viewId, [
              {
                kind: 'provider-row',
                at,
                providerMeta: null,
                message: new ThinkingMessage(at, `Synthetic hidden reasoning ${marker}.`),
              },
            ]);
          } finally {
            ledger.close();
          }
        },
      });
      await integration.client.waitForChatSearch(
        { query: marker, chatIds: [chatId] },
        (result) => result.results.length === 1,
      );
      await page.addInitScript(() => {
        const key = 'pref_local_settings';
        localStorage.setItem(
          key,
          JSON.stringify({
            ...JSON.parse(localStorage.getItem(key) ?? '{}'),
            showThinking: false,
          }),
        );
      });
      await page.goto(integration.garcon.baseUrl);
      await collapseCanonicalFilesWindow(page);
      await openSearch(page, marker);
      await selectResult(page);
      await page
        .getByText('Matching row is hidden or no longer available.', {
          exact: true,
        })
        .waitFor();
      await page.waitForURL(`**/chat/${chatId}`);
      assertNoBrowserErrors();
    },
  );
});

test('search cancels a target page at its deadline without installing a late row', async () => {
  await withChromiumFixture(
    'search-result-deadline',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const { target, marker } = await createSearchNavigationTarget(integration);
      await page.goto(integration.garcon.baseUrl);
      await collapseCanonicalFilesWindow(page);
      await openSearch(page, marker);
      await page.clock.install();
      const captured = new Deferred<Route>();
      await page.route('**/api/v1/chats/messages?*', async (route) => {
        if (
          new URL(route.request().url()).searchParams.get('beforeOrdinal') ===
            String(target.ordinal + 1) &&
          captured.resolve(route)
        )
          return;
        await route.continue();
      });
      await selectResult(page);
      const route = await withTimeout(
        captured.promise,
        20_000,
        () => 'Missing held search target request',
      );
      try {
        const composer = page.locator('textarea:visible');
        await composer.fill('Synthetic deadline draft.');
        await page.clock.fastForward(30_000);
        const notification = page.getByText('Could not open search result. Try again.', {
          exact: true,
        });
        await notification.waitFor();
        expect(await notification.count()).toBe(1);
        await releaseRequest(page, route);
        expect(await composer.inputValue()).toBe('Synthetic deadline draft.');
        expect(await composer.evaluate((node) => document.activeElement === node)).toBe(true);
        expect(
          await page
            .locator(`[data-chat-row-id="${target.transcriptViewId}:${target.ordinal}"]`)
            .count(),
        ).toBe(0);
        assertNoBrowserErrors();
      } finally {
        await route.continue().catch(() => undefined);
      }
    },
  );
});
