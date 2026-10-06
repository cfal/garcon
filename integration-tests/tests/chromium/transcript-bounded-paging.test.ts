import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { join } from 'node:path';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { ThinkingMessage } from '../../../common/chat-types.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test.each(['server', 'client'] as const)('[TLV5-PAGE.07-CHROMIUM-BOUNDED-01] bounds %s-hidden history and keeps manual continuation available', async (hiddenBy) => {
  await withChromiumFixture(`transcript-${hiddenBy}-hidden-bounded-paging`, async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, directAgents } = integration;
    const chatId = integration.newChatId();
    const initial = await client.startDirectChat({
      chatId, content: 'Synthetic context behind hidden history',
      projectPath: integration.dirs.project, agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, initial.turnId);
    await client.waitForProcessing(chatId, false);
    await integration.restartGarcon({ beforeStart: async () => {
      const ledger = new TranscriptLedgerStore(join(integration.dirs.workspace, 'transcript-ledgers'));
      try {
        const view = ledger.currentView(chatId);
        if (!view) throw new Error('Missing synthetic transcript view');
        for (let batch = 0; batch < 20; batch += 1) {
          ledger.append(chatId, view.viewId, Array.from({ length: 500 }, () => hiddenBy === 'client' ? ({
            kind: 'provider-row' as const, at: '2026-01-01T00:00:00.000Z',
            message: new ThinkingMessage('2026-01-01T00:00:00.000Z', 'Synthetic hidden thought'),
          }) : ({
            kind: 'run-ended' as const, at: '2026-01-01T00:00:00.000Z',
            outcome: 'finished' as const, origin: 'core' as const,
          })));
        }
      } finally {
        ledger.close();
      }
    } });
    await page.addInitScript(() => {
      const key = 'pref_local_settings';
      const settings = JSON.parse(localStorage.getItem(key) ?? '{}');
      localStorage.setItem(key, JSON.stringify({ ...settings, showThinking: false, combineToolUseMessages: false }));
    });
    const requestedLimits: number[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/chats/messages') && url.searchParams.get('chatId') === chatId) {
        requestedLimits.push(Number(url.searchParams.get('limit')));
      }
    });
    phase('loading a hidden-only tail');
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const feed = page.locator('[data-chat-scroll-viewport]');
    const earlier = feed.getByRole('button', { name: 'Load earlier messages', exact: true });
    await browserExpect(earlier).toBeVisible();
    await browserExpect(feed).toHaveAttribute('data-chat-earlier-page-status', 'bounded');
    await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
    await browserExpect(feed.getByText('No messages yet', { exact: true })).toHaveCount(0);
    // Activation and panel restoration can each own a snapshot demand; autofill shares one further allowance.
    expect(requestedLimits.length).toBeLessThanOrEqual(30);
    expect(requestedLimits.every((limit) => limit > 0 && limit <= 200)).toBe(true);
    const before = Number(await feed.getAttribute('data-chat-next-before-ordinal'));
    expect(before).toBeGreaterThan(1);
    phase('resuming from the retained raw boundary');
    const earlierButton = await earlier.elementHandle();
    if (!earlierButton) throw new Error('Missing manual transcript continuation');
    await earlier.click();
    await browserExpect.poll(async () => Number(await feed.getAttribute('data-chat-next-before-ordinal'))).toBeLessThan(before);
    await browserExpect(feed).toHaveAttribute('data-chat-earlier-page-status', 'bounded');
    await browserExpect(earlier).toBeEnabled();
    await browserExpect(earlier).toBeFocused();
    expect(await earlier.evaluate((node, original) => node === original, earlierButton)).toBe(true);
    expect(requestedLimits.length).toBeLessThanOrEqual(40);
    const resumedBefore = Number(await feed.getAttribute('data-chat-next-before-ordinal'));
    phase('retaining bounded forward continuation after initial-window navigation');
    await page.locator('button[title="Scroll to initial prompt"]').click();
    const later = feed.getByRole('button', { name: 'Load later messages', exact: true });
    await browserExpect(later).toBeVisible();
    await browserExpect(feed.getByText('Synthetic context behind hidden history', { exact: true })).toBeVisible();
    const beforeLater = requestedLimits.length;
    await later.click();
    await browserExpect.poll(() => requestedLimits.length).toBeGreaterThan(beforeLater);
    await browserExpect(later).toBeEnabled();
    await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
    phase('restoring the latest hidden window without losing its earlier boundary');
    await page.locator('button[title="Scroll to bottom"]').click();
    await browserExpect(earlier).toBeVisible();
    await browserExpect(feed).toHaveAttribute('data-chat-earlier-page-status', 'bounded');
    if (hiddenBy === 'server') {
      expect(Number(await feed.getAttribute('data-chat-next-before-ordinal'))).toBeLessThanOrEqual(resumedBefore);
      await page.waitForFunction(({ chatId, resumedBefore }) => {
        const cached = JSON.parse(localStorage.getItem(`chat_snapshot_${chatId}`) ?? 'null');
        return cached !== null && cached.nextBeforeOrdinal <= resumedBefore;
      }, { chatId, resumedBefore });
      await page.reload();
      await browserExpect(earlier).toBeVisible();
      await browserExpect(feed).toHaveAttribute('aria-busy', 'false');
      expect(Number(await feed.getAttribute('data-chat-next-before-ordinal'))).toBeLessThanOrEqual(resumedBefore);
    }
    assertNoBrowserErrors();
  });
}, 120_000);
