import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Locator } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { AmpOracleToolUseMessage, CompactionMessage } from '../../../common/chat-types.js';
import type { AddChatRowRequest, ChatRowTargetResponse } from '../../../common/chat-row-contracts.js';
import type { ShareChatResponse } from '../../../common/share-types.js';
import type { SnippetsSnapshot } from '../../../common/snippets.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';

const ARTIFACT_DIRECTORY = join(import.meta.dirname, '../../artifacts/chromium');

test('Terminal UI Style squares composer surfaces without changing Standard', async () => {
  await withChromiumFixture('terminal composer surfaces', async ({ page, integration, assertNoBrowserErrors }) => {
    await initializeFixtureRepository(integration.dirs.project);
    const snippets = await integration.client.get<SnippetsSnapshot>('/api/v1/snippets');
    await integration.client.post('/api/v1/snippets', {
      expectedRevision: snippets.revision,
      snippet: { shortName: 'review', template: 'Synthetic snippet text', defaultArguments: '' },
    });
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({
      chatId, content: 'Synthetic composer appearance seed',
      projectPath: integration.dirs.project, agent: integration.directAgents.anthropic,
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await integration.client.waitForProcessing(chatId, false);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const composer = page.locator('[data-composer]:visible');
    const input = composer.locator('textarea');
    await input.fill('Synthetic retained draft');
    await composer.locator('input[type="file"]').setInputFiles({
      name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Synthetic attachment'),
    });
    const attachments = composer.locator('[data-slot="composer-attachments"]');
    const preview = attachments.locator('[data-slot="composer-attachment-preview"]');
    const tray = page.locator('[data-slot="chat-git-status"]:visible');
    const menu = page.locator('[data-slot="composer-completion-menu"]:visible');
    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });

    async function checkCorners(surfaces: Locator[], screenshot?: string) {
      const baselines = [];
      for (const surface of surfaces) {
        await browserExpect(surface).toBeVisible();
        const standardRadius = await surface.evaluate(element => getComputedStyle(element).borderRadius);
        expect(parseFloat(standardRadius)).toBeGreaterThan(0);
        baselines.push({ surface, standardRadius });
      }
      for (const terminalAppearance of [true, false]) {
        await page.evaluate(terminalAppearance => {
          const key = 'pref_local_settings';
          localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? '{}'), terminalAppearance }));
          window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
        }, terminalAppearance);
        await browserExpect(page.locator('html')).toHaveAttribute('data-theme-appearance', terminalAppearance ? 'terminal' : 'standard');
        for (const { surface, standardRadius } of baselines) {
          await browserExpect(surface).toBeVisible();
          await browserExpect(surface).toHaveCSS('border-radius', terminalAppearance ? '0px' : standardRadius);
        }
        if (terminalAppearance && screenshot) {
          await page.screenshot({
            path: join(ARTIFACT_DIRECTORY, screenshot),
            animations: 'disabled',
          });
        }
      }
    }

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await checkCorners([tray, attachments, preview], `terminal-composer-${width}.png`);
      await browserExpect(input).toHaveValue('Synthetic retained draft');
      const commit = tray.getByRole('button', { name: /^Commit/ });
      await commit.focus();
      await checkCorners([page.getByRole('tooltip')]);
      await commit.press('Escape');
      await browserExpect(page.getByRole('tooltip')).toHaveCount(0);
      for (const query of ['/rename', '@example']) {
        await input.fill(query);
        await browserExpect(menu).toContainText(query === '/rename' ? '/rename' : 'example.txt');
        await checkCorners([menu]);
        await input.press('Enter');
        await browserExpect(menu).toHaveCount(0);
        await browserExpect(input).toHaveValue(query === '/rename' ? '/rename ' : '@example.txt ');
      }
      await input.fill(';;');
      const palette = page.getByRole('dialog', { name: 'Insert Snippet' });
      const option = palette.getByRole('option', { name: /^review\b/ });
      await browserExpect(option).toHaveAttribute('aria-selected', 'true');
      await checkCorners([option]);
      await palette.getByRole('combobox', { name: 'Search snippets' }).press('Enter');
      await browserExpect(palette).toHaveCount(0);
      await browserExpect(input).toHaveValue('Synthetic snippet text');
      await input.fill('Synthetic retained draft');
    }
    await composer.getByRole('button', { name: 'Remove attachment notes.md' }).click();
    await browserExpect(attachments).toHaveCount(0);

    const prompt = 'Synthetic held appearance turn';
    const held = integration.fakeProviders.anthropic.holdNext({ lastUserText: prompt });
    try {
      const accepted = await integration.client.runDirectChat({ chatId, content: prompt, agent: integration.directAgents.anthropic });
      await held.received;
      await integration.client.pauseQueue(chatId);
      await integration.client.enqueueNew(chatId, 'Synthetic queued appearance input');
      const queue = page.locator('[data-queue-status-summary]');
      const loading = page.locator('[data-slot="chat-processing-status"]:visible');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await input.focus();
        await checkCorners([queue, loading, composer], `terminal-queue-${width}.png`);
        await browserExpect(input).toHaveValue('Synthetic retained draft');
        await browserExpect(input).toBeFocused();
        await queue.getByRole('button', { name: 'Edit queued message', exact: true }).click();
        const editor = page.getByRole('dialog');
        await checkCorners([editor.locator('[data-slot="prompt-text-field"]')], `terminal-queue-editor-${width}.png`);
        await browserExpect(editor.locator('textarea')).toHaveValue('Synthetic queued appearance input');
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        await browserExpect(editor).toHaveCount(0);
      }
      held.releaseEcho();
      await integration.client.waitForTurnTerminal(chatId, accepted.turnId!);
    } finally {
      held.releaseEcho();
    }
    assertNoBrowserErrors();
  });
}, 60_000);

test.each(['live', 'shared'] as const)('Terminal UI Style gives %s chat event cards consistent corners', async (view) => {
  await withChromiumFixture(`terminal ${view} chat row corners`, async ({ page, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const started = await integration.client.startChat({
      ...integration.client.directStartRequest({
        chatId,
        content: 'Synthetic review response',
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      }),
      userMessagePresentation: { origin: 'cli', style: 'info', title: 'Oracle review response' },
    });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    await integration.client.waitForProcessing(chatId, false);
    await integration.restartGarcon({
      beforeStart: async () => {
        const ledger = new TranscriptLedgerStore(join(integration.dirs.workspace, 'transcript-ledgers'));
        try {
          const view = ledger.currentView(chatId)!;
          const at = '2026-01-01T00:00:00.000Z';
          ledger.append(chatId, view.viewId, [
            new CompactionMessage(at, 'manual', 'Synthetic compaction summary'),
            new AmpOracleToolUseMessage(at, 'synthetic-oracle', 'Synthetic tool review'),
          ].map((message) => ({ kind: 'provider-row' as const, at, message, providerMeta: null })));
        } finally {
          ledger.close();
        }
      },
    });
    const target = await integration.client.get<ChatRowTargetResponse>(
      `/api/v1/chats/rows?chatId=${chatId}`,
    );
    await integration.client.post('/api/v1/chats/rows', {
      clientRequestId: 'synthetic-review-request',
      clientMessageId: 'synthetic-review-message',
      chatId,
      transcriptViewId: target.transcriptViewId,
      presentation: { style: 'info' },
      format: 'plain',
      disclosure: 'collapsed',
      title: 'Oracle review request',
      content: 'Synthetic review instructions',
    } satisfies AddChatRowRequest);
    await page.addInitScript(seedLocalSettings, { combineToolUseMessages: false });
    let path = `/chat/${chatId}`;
    if (view === 'shared') {
      const share = await integration.client.post<ShareChatResponse>('/api/v1/chats/share', { chatId });
      path = `/shared/${share.shareToken}`;
    }
    await page.goto(`${integration.garcon.baseUrl}${path}`);

    const feed = view === 'shared'
      ? page.locator('[data-chat-feed-content]')
      : page.getByRole('region', { name: 'Chat messages', exact: true });
    const compaction = feed.getByRole('article').filter({ hasText: 'Context compacted' });
    const request = feed.getByRole('article').filter({ hasText: 'Oracle review request' });
    const tool = feed.getByRole('article').filter({ hasText: 'Oracle' }).filter({ hasNotText: 'Oracle review request' });
    const response = feed.locator(view === 'shared' ? '[data-slot="shared-user-message"]' : '.user-message-context-target')
      .filter({ hasText: 'Oracle review response' });
    const cards: { card: Locator; standardRadius: string }[] = [];
    const visibleCards = view === 'shared' ? [request, tool, response] : [compaction, request, tool, response];
    for (const card of visibleCards) {
      await browserExpect(card).toBeVisible();
      const standardRadius = await card.evaluate((element) => getComputedStyle(element).borderRadius);
      expect(parseFloat(standardRadius)).toBeGreaterThan(0);
      cards.push({ card, standardRadius });
    }

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const appearance of ['standard', 'terminal', 'standard']) {
        await page.evaluate((terminalAppearance) => {
          const key = 'pref_local_settings';
          localStorage.setItem(key, JSON.stringify({
            ...JSON.parse(localStorage.getItem(key) ?? '{}'),
            terminalAppearance,
          }));
          window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage }));
        }, appearance === 'terminal');
        await browserExpect(page.locator('html')).toHaveAttribute('data-theme-appearance', appearance);
        for (const { card, standardRadius } of cards) {
          await browserExpect(card).toBeVisible();
          await browserExpect(card).toHaveCSS(
            'border-radius',
            appearance === 'terminal' ? '0px' : standardRadius,
          );
        }
        if (appearance === 'terminal') {
          if (view === 'live') {
            await compaction.getByRole('button', { name: 'Show summary' }).click();
            await browserExpect(compaction.getByText('Synthetic compaction summary')).toBeVisible();
            await browserExpect(compaction).toHaveCSS('border-radius', '0px');
          }
          await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
          await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `terminal-${view}-chat-rows-${width}.png`) });
          if (view === 'live') await compaction.getByRole('button', { name: 'Hide summary' }).click();
        }
      }
    }
    assertNoBrowserErrors();
  });
}, 60_000);

test.each([1440, 390])(
  'Terminal UI Style opens directly into an interactive workspace at %ipx',
  async (width) => {
    await withChromiumFixture(
      `terminal immediate workspace ${width}`,
      async ({ page, context, integration, assertNoBrowserErrors }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.addInitScript(seedLocalSettings, {
          terminalAppearance: true,
          reduceMotion: false,
        });
        const start = Date.now();
        await page.clock.install({ time: start });
        await page.clock.pauseAt(start + 1000);
        const protocol = await context.newCDPSession(page);
        try {
          await protocol.send('Emulation.setTouchEmulationEnabled', {
            enabled: width === 390,
          });
          await page.goto(integration.garcon.baseUrl);
          await browserExpect(
            page.locator('[data-workspace-content]'),
          ).toBeVisible();
          await browserExpect(page.locator('html')).toHaveAttribute(
            'data-theme-appearance',
            'terminal',
          );
          await browserExpect(page.locator('[data-ansi-startup]')).toHaveCount(0);
          await page.clock.resume();
          const newChat = page
            .getByRole('button', { name: 'New Chat', exact: true })
            .first();
          if (width === 390) {
            const bounds = (await newChat.boundingBox())!;
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchStart',
              touchPoints: [
                {
                  x: bounds.x + bounds.width / 2,
                  y: bounds.y + bounds.height / 2,
                  id: 1,
                },
              ],
            });
            await protocol.send('Input.dispatchTouchEvent', {
              type: 'touchEnd',
              touchPoints: [],
            });
          } else {
            await newChat.click();
          }
          const dialog = page.getByRole('dialog');
          await browserExpect(dialog).toBeVisible();
          const prompt = dialog.getByPlaceholder('How can I help you today?');
          await prompt.fill('Synthetic immediate input');
          await browserExpect(prompt).toHaveValue('Synthetic immediate input');
          assertNoBrowserErrors();
        } finally {
          await protocol.detach();
        }
      },
    );
  },
  60_000,
);

test('ANSI workspace keeps drafts and composer geometry through chat switches', async () => {
  await withChromiumFixture(
    'ANSI chat switches',
    async ({ page, integration, assertNoBrowserErrors }) => {
      const ids = [integration.newChatId(), integration.newChatId()];
      for (const [index, chatId] of ids.entries()) {
        const started = await integration.client.startDirectChat({
          chatId,
          content: `Synthetic ANSI workspace sample ${index + 1}`,
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await integration.client.waitForTurnTerminal(chatId, started.turnId);
        await integration.client.waitForProcessing(chatId, false);
      }
      await page.addInitScript(seedLocalSettings, {
        themePreference: { mode: 'fixed', themeId: 'ansi-dark' },
        terminalAppearance: true,
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${ids[0]}`);
      await browserExpect(page.getByText('GARCON://', { exact: true })).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const composer = page.locator('[data-composer]');
      const editor = composer.locator('textarea');
      const owner = page.locator('[data-conversation-panel-composer-anchor="true"]');
      const draft = 'Synthetic retained ANSI draft';
      await editor.fill(draft);
      await editor.evaluate((element) => element.setAttribute('data-retained-editor', 'true'));
      const before = await composer.boundingBox();
      expect(await page.locator('[data-workspace-window-id]').count()).toBeGreaterThanOrEqual(2);
      await browserExpect(
        page.locator('[data-workspace-window-fullscreen] > svg').first(),
      ).toBeVisible();
      const chatBody = await page.locator('[data-workspace-live-chat-body]').boundingBox();
      const titlebar = await page
        .locator('[data-workspace-window-current="true"] [data-workspace-window-titlebar]')
        .boundingBox();
      expect(chatBody!.y).toBeGreaterThanOrEqual(titlebar!.y + titlebar!.height);
      for (const chatId of [ids[1], ids[0], ids[1], ids[0]]) {
        await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
        await browserExpect(owner).toHaveAttribute('data-conversation-panel-chat-id', chatId);
        await browserExpect(editor).toHaveValue(chatId === ids[0] ? draft : '');
        await browserExpect(editor).toHaveAttribute('data-retained-editor', 'true');
        expect((await composer.boundingBox())!.y).toBe(before!.y);
      }
      await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
      for (const width of [1440, 390, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(
          page
            .getByRole('region', { name: 'Chat messages', exact: true })
            .getByText('Synthetic ANSI workspace sample 1', { exact: true }),
        ).toBeVisible();
        await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `ansi-workspace-${width}.png`) });
        const box = (await composer.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(
          await editor.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
        ).toBeGreaterThanOrEqual(16);
      }
      assertNoBrowserErrors();
    },
  );
}, 60_000);

test('ANSI chrome stays usable on desktop and mobile, and leaves other themes unchanged', async () => {
  await withChromiumFixture('ANSI chrome', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await browserExpect(dialog).toBeVisible();
    await page.getByRole('radio', { name: 'Use one theme' }).click();
    const select = page.getByRole('combobox', { name: 'Theme', exact: true });
    const originalRadius = await dialog.evaluate(
      (element) => getComputedStyle(element).borderRadius,
    );
    const originalFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    const appearance = page.getByRole('combobox', {
      name: 'UI Style',
      exact: true,
    });
    const font = page.getByRole('button', { name: /^Interface Font:/ });
    const mono = page.getByRole('button', {
      name: /^Chat Code & Commands Font:/,
    });
    async function chooseFont(button: typeof font, value: string) {
      await button.click();
      const picker = page.getByRole('dialog', { name: / Font$/ });
      await picker.locator(`input[type="radio"][value="${value}"]`).check();
      await picker.getByRole('button', { name: 'Apply', exact: true }).click();
      await browserExpect(picker).toHaveCount(0);
    }
    await browserExpect(appearance).toHaveValue('default');
    const originalPalette = await select.inputValue();
    await appearance.selectOption('terminal');
    expect(await select.inputValue()).toBe(originalPalette);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      originalFont,
    );
    await browserExpect(font).toContainText('System UI');
    await browserExpect(mono).toContainText('System monospace');
    await chooseFont(font, 'departure-mono');
    await chooseFont(mono, 'departure-mono');
    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });

    for (const id of ['ansi-dark', 'ansi-light']) {
      await select.selectOption(id);
      await page.evaluate(() => document.fonts.ready);
      await browserExpect(dialog).toHaveCSS('border-radius', '0px');
      await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
      await browserExpect(dialog).toHaveCSS(
        'background-color',
        id === 'ansi-dark' ? 'rgb(23, 23, 23)' : 'rgb(247, 247, 247)',
      );
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
        'Departure Mono',
      );
      await select.focus();
      await browserExpect(select).toBeFocused();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await mono.scrollIntoViewIfNeeded();
        for (const control of [font, mono]) {
          expect(await control.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        }
        const fits = await appearance.evaluate((element: HTMLSelectElement) => {
          const styles = getComputedStyle(element);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
          return (
            context.measureText(element.selectedOptions[0].text).width <=
            element.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight)
          );
        });
        expect(fits).toBe(true);
        await page.screenshot({ path: join(ARTIFACT_DIRECTORY, `${id}-${width}.png`) });
        const box = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
    }
    await select.selectOption('phosphor-light');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
    await appearance.selectOption('default');
    expect(await select.inputValue()).toBe('phosphor-light');
    await browserExpect(dialog).toHaveCSS('border-radius', originalRadius);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(
      'Departure Mono',
    );
    await chooseFont(font, 'default');
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toBe(
      originalFont,
    );
    await browserExpect(dialog).toHaveCSS('border-top-style', 'solid');
    await select.selectOption('ansi-dark');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'solid');
    await appearance.selectOption('terminal');
    await browserExpect(dialog).toHaveCSS('border-top-style', 'double');
    await page.keyboard.press('Escape');
    await browserExpect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    const newChat = page.getByRole('dialog');
    await page
      .getByRole('status', { name: 'Loading chat defaults...' })
      .waitFor({ state: 'detached' });
    await page
      .getByPlaceholder('How can I help you today?')
      .fill('Synthetic multiline prompt\n'.repeat(20));
    await page.setViewportSize({ width: 390, height: 420 });
    await browserExpect(newChat).toHaveCSS('border-top-style', 'double');
    await browserExpect
      .poll(() => newChat.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const scroll = await newChat.evaluate((element) => {
      const before = element.getBoundingClientRect().toJSON();
      element.scrollTop = element.scrollHeight;
      return {
        before,
        after: element.getBoundingClientRect().toJSON(),
        top: element.scrollTop,
        fits: element.scrollWidth <= element.clientWidth,
      };
    });
    expect(scroll.top).toBeGreaterThan(0);
    expect(scroll.fits).toBe(true);
    expect(scroll.after).toEqual(scroll.before);
    await browserExpect(newChat).toHaveCSS('border-bottom-style', 'double');
    await newChat.screenshot({ path: join(ARTIFACT_DIRECTORY, 'ansi-dialog-scrolled.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('pref_local_settings')!);
      localStorage.setItem(
        'pref_local_settings',
        JSON.stringify({ ...settings, chatListDock: 'right' }),
      );
    });
    await page.reload();
    const panel = page.locator('[data-workspace-chat-list-panel]');
    await browserExpect(panel).toHaveAttribute('data-divider-edge', 'start');
    await browserExpect(panel).toHaveCSS('border-inline-start-style', 'double');
    await browserExpect(panel).toHaveCSS('border-inline-end-width', '0px');
    await browserExpect(page.locator('html')).toHaveAttribute('data-theme-appearance', 'terminal');
    await browserExpect(page.locator('html')).toHaveAttribute('data-theme', 'ansi-dark');
    assertNoBrowserErrors();
  });
}, 60_000);
