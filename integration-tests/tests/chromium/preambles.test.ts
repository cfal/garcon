import { describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Locator, Page } from 'playwright';
import type { CompleteChatHistoryResponse } from '../../../common/chat-view.js';
import type {
  PreambleDefinitionInput,
  PreamblesMutationResponse,
  PreamblesSnapshot,
} from '../../../common/preambles.js';
import { type ChromiumFixture, withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred, withTimeout } from '../../support/deferred.js';

interface ViewportScenario {
  name: string;
  width: number;
  height: number;
  touch: boolean;
}

type PreambleBrowserScope = typeof globalThis & {
  __preambleComposer?: HTMLTextAreaElement;
};

const viewportScenarios: readonly ViewportScenario[] = [
  { name: 'desktop', width: 1_440, height: 900, touch: false },
  { name: 'wide mobile', width: 700, height: 800, touch: true },
  { name: 'mobile portrait', width: 390, height: 844, touch: true },
  { name: 'mobile keyboard', width: 390, height: 390, touch: true },
  { name: 'narrow mobile', width: 320, height: 568, touch: true },
];

const preambles = [
  {
    title: 'Repository conventions for narrow workspaces',
    content: 'SYNTHETIC_CHROMIUM_PREAMBLE_BODY_ONE',
  },
  {
    title: 'Security and privacy constraints',
    content: 'SYNTHETIC_CHROMIUM_PREAMBLE_BODY_TWO',
  },
  {
    title: 'Verification requirements',
    content: 'SYNTHETIC_CHROMIUM_PREAMBLE_BODY_THREE',
  },
] as const;

async function setViewport(page: Page, cdp: CDPSession, scenario: ViewportScenario): Promise<void> {
  if (scenario.touch) {
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
  }
  await page.setViewportSize({
    width: scenario.width,
    height: scenario.height,
  });
  expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(!scenario.touch);
}

async function waitForDialogAnimations(dialog: Locator): Promise<void> {
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function openPreambles(
  page: Page,
  baseUrl: string,
): Promise<{
  trigger: Locator;
  dialog: Locator;
}> {
  const response = await page.goto(baseUrl);
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${String(response?.status())}.`);
  const trigger = page.getByRole('button', { name: 'More actions' }).first();
  if (await page.evaluate(() => matchMedia('(max-width: 768px)').matches)) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  }
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Preambles', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Preambles', exact: true });
  await dialog.waitFor();
  await waitForDialogAnimations(dialog);
  return { trigger, dialog };
}

async function dialogLayout(dialog: Locator, fieldNames: readonly string[] = []) {
  return dialog.evaluate((element, names) => {
    const root = element as HTMLElement;
    const body = root.querySelector<HTMLElement>('[data-slot="preambles-scroll-body"]');
    if (!body) throw new Error('Missing scrollable dialog body.');
    const rect = root.getBoundingClientRect();
    const fieldFontSizes = Object.fromEntries(
      names.map((name) => {
        const field = [
          ...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
        ].find(
          (candidate) =>
            candidate.getAttribute('aria-label') === name ||
            candidate.labels?.[0]?.textContent?.trim() === name,
        );
        if (!field) throw new Error(`Missing dialog field: ${name}`);
        return [name, getComputedStyle(field).fontSize];
      }),
    );
    return {
      rect: {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      },
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      dialogOverflow: getComputedStyle(root).overflow,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      fieldFontSizes,
    };
  }, fieldNames);
}

function expectContainedDialog(
  layout: Awaited<ReturnType<typeof dialogLayout>>,
  scenario: ViewportScenario,
): void {
  expect(layout.rect.top).toBeGreaterThanOrEqual(-1);
  expect(layout.rect.left).toBeGreaterThanOrEqual(-1);
  expect(layout.rect.right).toBeLessThanOrEqual(scenario.width + 1);
  expect(layout.rect.bottom).toBeLessThanOrEqual(scenario.height + 1);
  expect(layout.bodyOverflowY).toBe('auto');
  expect(layout.dialogOverflow).toBe('hidden');
  expect(layout.documentOverflow).toBeLessThanOrEqual(1);
}

async function expectFocusWithin(page: Page, container: Locator): Promise<void> {
  const element = await container.elementHandle();
  if (!element) throw new Error('Missing focus container.');
  await page.waitForFunction(
    (target) => target instanceof HTMLElement && target.contains(document.activeElement),
    element,
  );
}

async function expectFocused(page: Page, target: Locator): Promise<void> {
  const element = await target.elementHandle();
  if (!element) throw new Error('Missing focus target.');
  await page.waitForFunction((candidate) => document.activeElement === candidate, element);
}

async function createGlobalPreambles(fixture: ChromiumFixture): Promise<void> {
  let snapshot = await fixture.integration.client.get<PreamblesSnapshot>('/api/v1/preambles');
  for (const preamble of preambles) {
    const definition: PreambleDefinitionInput = {
      enabled: true,
      title: preamble.title,
      content: preamble.content,
      scope: { type: 'global' },
    };
    const response = await fixture.integration.client.post<PreamblesMutationResponse>(
      '/api/v1/preambles',
      { expectedRevision: snapshot.revision, preamble: definition },
    );
    snapshot = response.snapshot;
  }
}

async function completeChat(
  fixture: ChromiumFixture,
  chatId: string,
  content: string,
): Promise<void> {
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe(
    'agent-run-finished',
  );
}

describe('Chromium preambles', () => {
  test('keeps nested catalog dialogs usable and restores focus across desktop and touch layouts', async () => {
    for (const scenario of viewportScenarios) {
      const fixtureName = `preambles-dialog-layout-focus-${scenario.name.replaceAll(' ', '-')}`;
      await withChromiumFixture(fixtureName, async (fixture, markPhase) => {
        await mkdir(join(fixture.integration.dirs.project, 'nested-directory'));
        const cdp = await fixture.context.newCDPSession(fixture.page);
        markPhase(`checking ${scenario.name} preamble dialogs`);
        await setViewport(fixture.page, cdp, scenario);
        const { trigger, dialog: manager } = await openPreambles(
          fixture.page,
          fixture.integration.garcon.baseUrl,
        );
        await fixture.page.waitForFunction(
          (height) =>
            document.documentElement.style.getPropertyValue('--app-height') ===
            `${String(height)}px`,
          scenario.height,
        );

        const managerLayout = await dialogLayout(manager);
        expectContainedDialog(managerLayout, scenario);
        await expectFocusWithin(fixture.page, manager);
        await fixture.page.keyboard.press('Shift+Tab');
        await expectFocusWithin(fixture.page, manager);
        if (scenario.touch) {
          expect(managerLayout.rect.width).toBeGreaterThanOrEqual(scenario.width - 1);
          expect(managerLayout.rect.height).toBeGreaterThanOrEqual(scenario.height - 1);
        } else {
          expect(managerLayout.rect.width).toBeLessThanOrEqual(768);
          expect(managerLayout.rect.height).toBeLessThanOrEqual(704);
        }

        const addPreamble = manager.getByRole('button', {
          name: 'Add preamble',
        });
        await addPreamble.click();
        const form = fixture.page.getByRole('dialog', {
          name: 'Add Preamble',
          exact: true,
        });
        await form.waitFor();
        await waitForDialogAnimations(form);
        await expectFocusWithin(fixture.page, form);

        const title = form.getByRole('textbox', { name: 'Title', exact: true });
        const content = form.getByRole('textbox', {
          name: 'Preamble text',
          exact: true,
        });
        await title.fill('Chromium layout preamble');
        await content.fill(
          Array.from({ length: 20 }, (_, index) => `Preamble line ${String(index + 1)}`).join('\n'),
        );
        const formLayout = await dialogLayout(form, ['Title', 'Preamble text']);
        expectContainedDialog(formLayout, scenario);
        expect(formLayout.fieldFontSizes).toEqual({
          Title: scenario.touch ? '16px' : '14px',
          'Preamble text': scenario.touch ? '16px' : '14px',
        });
        if (scenario.touch) {
          expect(formLayout.rect.width).toBeGreaterThanOrEqual(scenario.width - 1);
          expect(formLayout.rect.height).toBeGreaterThanOrEqual(scenario.height - 1);
        } else {
          expect(formLayout.rect.width).toBeLessThanOrEqual(768);
          expect(formLayout.rect.height).toBeLessThanOrEqual(768);
        }
        if (scenario.name === 'mobile keyboard') {
          expect(formLayout.bodyScrollHeight).toBeGreaterThan(formLayout.bodyClientHeight);
        }

        await content.evaluate((element) => {
          const textarea = element as HTMLTextAreaElement;
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(2, 8);
        });
        const formBody = form.locator('[data-slot="preambles-scroll-body"]');
        const scrollBeforeEditor = await formBody.evaluate((element) => element.scrollTop);
        await form
          .getByRole('button', { name: 'Expand preamble editor' })
          .evaluate((element) => (element as HTMLButtonElement).click());
        const editor = fixture.page.getByRole('dialog', {
          name: 'Edit Preamble Text',
          exact: true,
        });
        await editor.waitFor();
        const editorContent = editor.locator('.cm-content[aria-label="Preamble text"]');
        await editorContent.waitFor();
        await fixture.page.waitForFunction(
          () => document.activeElement?.matches('.cm-content[aria-label="Preamble text"]') === true,
        );
        await editor.getByRole('button', { name: 'Close expanded editor' }).click();
        await editor.waitFor({ state: 'detached' });
        expect(
          await content.evaluate((element) => {
            const textarea = element as HTMLTextAreaElement;
            return {
              focused: document.activeElement === textarea,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
            };
          }),
        ).toEqual({ focused: true, selectionStart: 2, selectionEnd: 8 });
        expect(
          Math.abs((await formBody.evaluate((element) => element.scrollTop)) - scrollBeforeEditor),
        ).toBeLessThanOrEqual(1);

        await form.getByRole('radio', { name: /Project paths/ }).click();
        const addPath = form.getByRole('button', { name: 'Add project path' });
        await addPath.click();
        const directoryBrowser = fixture.page.locator('[data-slot="directory-browser"]');
        await directoryBrowser.waitFor();
        if (scenario.touch) {
          await expectFocusWithin(fixture.page, directoryBrowser);
          const directoryEntry = directoryBrowser.getByRole('listbox').locator('button').first();
          const directoryEntryElement = await directoryEntry.elementHandle();
          if (!directoryEntryElement) throw new Error('Missing directory entry.');
          await directoryEntry.focus();
          await directoryEntry.click();
          await fixture.page.waitForFunction(
            (element) => element instanceof HTMLElement && !element.isConnected,
            directoryEntryElement,
          );
          await expectFocusWithin(fixture.page, directoryBrowser);
          await fixture.page.keyboard.press('Shift+Tab');
          await expectFocusWithin(fixture.page, directoryBrowser);
          await fixture.page.keyboard.press('Tab');
          await expectFocusWithin(fixture.page, directoryBrowser);
          const bounds = await directoryBrowser.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds?.width).toBeGreaterThanOrEqual(scenario.width - 1);
          expect(bounds?.height).toBeGreaterThanOrEqual(scenario.height - 1);
          await directoryBrowser.getByRole('button', { name: 'Cancel' }).click();
        } else {
          await expectFocused(fixture.page, addPath);
          expect(
            await fixture.page.locator('[data-slot="directory-browser-dismiss"]').count(),
          ).toBe(1);
          await fixture.page
            .locator('[data-slot="directory-browser-dismiss"]')
            .evaluate((element) => (element as HTMLButtonElement).click());
        }
        await directoryBrowser.waitFor({ state: 'detached' });
        await expectFocused(fixture.page, addPath);

        const projectPathLayout = await dialogLayout(form, ['Project path']);
        expect(projectPathLayout.fieldFontSizes['Project path']).toBe(
          scenario.touch ? '16px' : '14px',
        );
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await form.waitFor({ state: 'detached' });
        await expectFocused(fixture.page, addPreamble);

        await manager.getByRole('button', { name: 'Close', exact: true }).click();
        await manager.waitFor({ state: 'detached' });
        await expectFocused(fixture.page, trigger);
        fixture.assertNoBrowserErrors();
      });
    }
  });

  test('preserves the active composer during a background application and wraps the notice narrowly', async () => {
    await withChromiumFixture('preambles-background-application', async (fixture, markPhase) => {
      await createGlobalPreambles(fixture);
      const controlChatId = fixture.integration.newChatId();
      const controlPrompt = Array.from(
        { length: 80 },
        (_, index) => `Chromium control transcript paragraph ${String(index + 1)}.`,
      ).join('\n\n');
      await completeChat(fixture, controlChatId, controlPrompt);

      markPhase('opening the control chat');
      await fixture.page.goto(
        `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(controlChatId)}`,
      );
      const feed = fixture.page.locator('[data-chat-scroll-viewport]');
      await feed.waitFor();
      const composer = fixture.page.locator('textarea[placeholder="Reply..."]:visible');
      await composer.fill('preserved draft');
      await composer.focus();
      await composer.evaluate((element) => {
        (globalThis as PreambleBrowserScope).__preambleComposer = element as HTMLTextAreaElement;
      });
      await feed.evaluate(async (element) => {
        const scrollViewport = element as HTMLElement;
        const maximum = scrollViewport.scrollHeight - scrollViewport.clientHeight;
        if (maximum < 100) throw new Error('Control transcript does not produce a scroll range.');
        scrollViewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }));
        scrollViewport.scrollTop = maximum / 2;
        scrollViewport.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      const activeLayout = await fixture.page.evaluate(() => {
        const scope = globalThis as PreambleBrowserScope;
        const composerElement = scope.__preambleComposer;
        const activeFeed = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
        if (!composerElement || !activeFeed) throw new Error('Missing active chat elements.');
        const rect = composerElement.getBoundingClientRect();
        return {
          composerRect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          feedScrollTop: activeFeed.scrollTop,
        };
      });
      expect(activeLayout.feedScrollTop).toBeGreaterThan(0);

      const targetPrompt = 'chromium preamble background prompt';
      const targetChatId = fixture.integration.newChatId();
      const held = fixture.integration.fakeProviders.openAi.holdNext({
        model: fixture.integration.directAgents.openAi.provider.model,
      });
      let turnId: string | undefined;
      let heldReleased = false;
      try {
        markPhase('appending the background preamble application');
        const startedPromise = fixture.integration.client.startDirectChat({
          chatId: targetChatId,
          content: targetPrompt,
          projectPath: fixture.integration.dirs.project,
          agent: fixture.integration.directAgents.openAi,
        });
        await held.received;
        const started = await startedPromise;
        turnId = started.turnId;
        const targetRow = fixture.page.locator(`[data-sidebar-virtual-row="${targetChatId}"]`);
        await targetRow.waitFor();
        const processingIndicator = targetRow.locator(
          '[data-slot="sidebar-chat-processing-indicator"]',
        );
        await processingIndicator.waitFor();
        held.releaseText('chromium preamble background response');
        heldReleased = true;
        expect(
          (await fixture.integration.client.waitForTurnTerminal(targetChatId, turnId)).type,
        ).toBe('agent-run-finished');
        await processingIndicator.waitFor({ state: 'detached' });

        expect(
          await fixture.page.evaluate((expectedLayout) => {
            const scope = globalThis as PreambleBrowserScope;
            const composerElement = scope.__preambleComposer;
            const activeFeed = document.querySelector<HTMLElement>('[data-chat-scroll-viewport]');
            if (!composerElement || !activeFeed) return false;
            const rect = composerElement.getBoundingClientRect();
            return (
              document.activeElement === composerElement &&
              composerElement.isConnected &&
              composerElement.value === 'preserved draft' &&
              Math.abs(rect.x - expectedLayout.composerRect.x) <= 1 &&
              Math.abs(rect.y - expectedLayout.composerRect.y) <= 1 &&
              Math.abs(rect.width - expectedLayout.composerRect.width) <= 1 &&
              Math.abs(rect.height - expectedLayout.composerRect.height) <= 1 &&
              Math.abs(activeFeed.scrollTop - expectedLayout.feedScrollTop) <= 1
            );
          }, activeLayout),
        ).toBeTrue();

        markPhase('opening and measuring the applied target');
        const targetPage = await fixture.integration.client.get<CompleteChatHistoryResponse>(
          `/api/v1/chats/messages?chatId=${encodeURIComponent(targetChatId)}&limit=50`,
        );
        const targetHistoryResponse = new Deferred<void>();
        let targetHistoryRequestCount = 0;
        await fixture.page.route('**/api/v1/chats/messages?**', async (route) => {
          const url = new URL(route.request().url());
          if (url.searchParams.get('chatId') === targetChatId) {
            targetHistoryRequestCount += 1;
            await route.fulfill({
              json: {
                ...targetPage,
                messages: [],
                pageOldestOrdinal: 0,
                resendCandidates: [],
              },
            });
            targetHistoryResponse.resolve(undefined);
            return;
          }
          await route.continue();
        });
        await targetRow.locator('button').first().click();
        await fixture.page.waitForURL(new RegExp(`/chat/${targetChatId}$`));
        await withTimeout(
          targetHistoryResponse.promise,
          10_000,
          () => 'Timed out waiting for the empty target-history response.',
        );
        expect(targetHistoryRequestCount).toBeGreaterThan(0);
        const notice = fixture.page
          .locator('[data-chat-message-type="transcript-notice"]')
          .filter({ hasText: 'Preambles applied' });
        await notice.waitFor();
        const user = fixture.page.locator('[data-chat-message-type="user-message"]').filter({
          hasText: targetPrompt,
        });
        await user.waitFor();
        expect(
          await fixture.page.locator('[data-chat-message-type]').evaluateAll((rows, prompt) => {
            const noticeIndex = rows.findIndex(
              (row) =>
                row.getAttribute('data-chat-message-type') === 'transcript-notice' &&
                row.textContent?.includes('Preambles applied'),
            );
            const userIndex = rows.findIndex(
              (row) =>
                row.getAttribute('data-chat-message-type') === 'user-message' &&
                row.textContent?.trim() === prompt,
            );
            return noticeIndex >= 0 && userIndex === noticeIndex + 1;
          }, targetPrompt),
        ).toBeTrue();
        expect(
          await notice.locator('[data-slot="preamble-application-title"]').allTextContents(),
        ).toEqual(preambles.map((preamble) => preamble.title));
        for (const preamble of preambles) {
          expect(await fixture.page.getByText(preamble.content, { exact: false }).count()).toBe(0);
        }

        const cdp = await fixture.context.newCDPSession(fixture.page);
        await setViewport(fixture.page, cdp, {
          name: 'narrow application',
          width: 320,
          height: 568,
          touch: true,
        });
        await fixture.page.waitForFunction(
          () => document.documentElement.style.getPropertyValue('--app-height') === '568px',
        );
        const noticeLayout = await notice.evaluate((element) => {
          const root = element as HTMLElement;
          const rootRect = root.getBoundingClientRect();
          const titleRects = [
            ...root.querySelectorAll<HTMLElement>('[data-slot="preamble-application-title"]'),
          ].map((title) => title.getBoundingClientRect());
          return {
            overflow: root.scrollWidth - root.clientWidth,
            titleRows: new Set(titleRects.map((rect) => Math.round(rect.top))).size,
            titlesContained: titleRects.every(
              (rect) => rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1,
            ),
            documentOverflow: document.documentElement.scrollWidth - innerWidth,
          };
        });
        expect(noticeLayout.titlesContained).toBeTrue();
        expect(noticeLayout.overflow).toBeLessThanOrEqual(1);
        expect(noticeLayout.titleRows).toBeGreaterThan(1);
        expect(noticeLayout.documentOverflow).toBeLessThanOrEqual(1);
      } finally {
        await fixture.page.unroute('**/api/v1/chats/messages?**').catch(() => undefined);
        if (!heldReleased) held.releaseText('chromium preamble background response');
        if (turnId) {
          await fixture.integration.client
            .waitForTurnTerminal(targetChatId, turnId)
            .catch(() => undefined);
        }
      }
      fixture.assertNoBrowserErrors();
    });
  });
});
