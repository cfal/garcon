import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { expect as browserExpect } from 'playwright/test';
import { AssistantMessage, CodexSubagentToolUseMessage, ToolResultMessage, UserMessage } from '../../../common/chat-types.js';
import type { LedgerRowDraft } from '../../../server/controller/ledger/contracts.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { DISPLAY_FEED, observeDisplayWire, waitForDisplayIdle } from '../../support/transcript-display-browser.js';
import { appendDisplayRun, createDisplayChat, DISPLAY_TIMESTAMP } from '../../support/transcript-display-fixture.js';

const PAIRS = 1500;

async function seedConsumerChat(fixture: ChromiumFixture, extra: readonly LedgerRowDraft[] = []) {
  const { integration, page } = fixture;
  const chatId = await createDisplayChat(integration);
  let seeded: Awaited<ReturnType<typeof appendDisplayRun>> | undefined;
  await integration.restartGarcon({ beforeStart: async () => {
    seeded = await appendDisplayRun(integration.dirs.workspace, chatId, PAIRS);
    if (!extra.length) return;
    const store = new TranscriptLedgerStore(join(integration.dirs.workspace, 'transcript-ledgers'));
    try { store.append(chatId, seeded.transcriptViewId, extra); }
    finally { store.close(); }
  } });
  if (!seeded) throw new Error('Missing synthetic transcript');
  const wire = await observeDisplayWire(page);
  await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
  await collapseCanonicalFilesWindow(page);
  await waitForDisplayIdle(page);
  await wire.settle();
  return { ...seeded, wire };
}

function input(id: string, content: string): LedgerRowDraft {
  return { kind: 'user-input', at: DISPLAY_TIMESTAMP, providerMeta: null,
    detail: { clientMessageId: id, message: new UserMessage(DISPLAY_TIMESTAMP, content), attachments: [],
      steer: false, preambleBoundary: null, preamblePrefixReceipt: null } };
}

function expectNoHistoricalMembers(wire: Awaited<ReturnType<typeof observeDisplayWire>>) {
  expect(wire.bodies().filter(row => (row.message.type === 'bash-tool-use' || row.message.type === 'tool-result')
    && row.message.toolId.startsWith('synthetic-display-'))).toEqual([]);
  expect(wire.requests).not.toContain('/api/v1/chats/messages');
}

test('the complete resend list stays editable beyond 50 inputs without loading collapsed history', async () => {
  await withChromiumFixture('display-resend-consumer', async fixture => {
    const candidates = Array.from({ length: 65 }, (_, index) => `Synthetic resend input ${String(index).padStart(2, '0')}`);
    const excluded = candidates[0], included = candidates.at(-1)!;
    const { page, integration } = fixture;
    const seed = await seedConsumerChat(fixture, candidates.map((content, index) => input(`resend-${index}`, content)));
    const chips = page.locator('[data-slot="composer-resend-candidate"]');
    await browserExpect(chips).toHaveCount(candidates.length);
    await browserExpect(page.locator('[data-composer]').getByRole('button', { name: /^(Previous page|Next page|Resend status)$/ })).toHaveCount(0);
    await chips.filter({ hasText: excluded }).getByRole('button', { name: `Don't resend ${excluded}`, exact: true }).click();
    await browserExpect(chips).toHaveCount(candidates.length - 1);
    await browserExpect(chips.filter({ hasText: included })).toHaveCount(1);
    expectNoHistoricalMembers(seed.wire);
    const held = integration.fakeProviders.openAi.holdNext({});
    const afterIndex = integration.client.markEvents();
    try {
      await page.locator('[data-composer] textarea').fill('Synthetic next input');
      await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
      const request = await held.received;
      expect(Array.from(request.lastUserText.match(/Synthetic resend input \d+/g) ?? [])).toEqual(candidates.slice(1));
      await browserExpect(chips).toHaveCount(0);
      expect(request.lastUserText).toContain('Synthetic next input');
      expect(request.lastUserText).not.toContain(excluded);
      held.releaseText('Synthetic resend completed');
      await integration.client.waitForTurnTerminal(seed.chatId, undefined, { afterIndex });
      await page.getByText('Synthetic resend completed', { exact: true }).waitFor();
      await seed.wire.settle();
      expectNoHistoricalMembers(seed.wire);
    } finally { held.releaseEcho(); }
  });
}, 120_000);

test('the subagent toolbar resolves an unhydrated canonical row directly', async () => {
  await withChromiumFixture('display-subagent-consumer', async fixture => {
    const toolId = 'synthetic-worker-spawn';
    const seed = await seedConsumerChat(fixture, [
      { kind: 'provider-row', at: DISPLAY_TIMESTAMP, providerMeta: null,
        message: new CodexSubagentToolUseMessage(DISPLAY_TIMESTAMP, toolId, 'spawn_agent', { taskName: 'synthetic-worker', model: 'generic-model' }) },
      { kind: 'provider-row', at: DISPLAY_TIMESTAMP, providerMeta: null,
        message: new ToolResultMessage(DISPLAY_TIMESTAMP, toolId, { agent_id: 'synthetic-worker-thread', nickname: 'synthetic-worker' }, false) },
      ...Array.from({ length: 60 }, (_, index): LedgerRowDraft => ({ kind: 'provider-row', at: DISPLAY_TIMESTAMP, providerMeta: null,
        message: new AssistantMessage(DISPLAY_TIMESTAMP, `Synthetic later context ${index}`) })),
    ]);
    const { page } = fixture;
    await page.getByRole('button', { name: /^Agents/ }).click();
    const worker = page.getByRole('button').filter({ hasText: 'synthetic-worker' });
    await browserExpect(worker).toBeVisible();
    await seed.wire.settle();
    expectNoHistoricalMembers(seed.wire);
    expect(seed.wire.bodies().some(row => row.ordinal === seed.sourceHead + 1)).toBe(false);
    await worker.click();
    await browserExpect(page.locator(`[data-chat-row-id="${seed.transcriptViewId}:${seed.sourceHead + 1}"]`)).toBeVisible();
    await waitForDisplayIdle(page);
    await seed.wire.settle();
    expect(seed.wire.bodies().filter(row => row.message.type === 'bash-tool-use').length).toBeLessThanOrEqual(50);
    expect(await page.locator('[data-chat-virtual-item]').count()).toBeLessThan(110);
  });
}, 120_000);

test('Fork at message uses the selected canonical row without hydrating later tool members', async () => {
  await withChromiumFixture('display-fork-row-consumer', async fixture => {
    const seed = await seedConsumerChat(fixture);
    const { page, integration } = fixture;
    expectNoHistoricalMembers(seed.wire);
    const row = page.locator(`[data-chat-row-id="${seed.transcriptViewId}:${seed.promptOrdinal}"]`);
    await row.getByRole('button', { name: 'More message actions', exact: true }).click();
    const forkRequest = page.waitForRequest(request => request.url().endsWith('/chats/fork'));
    const forkResponse = page.waitForResponse(response => response.url().endsWith('/chats/fork'));
    await page.getByRole('menuitem', { name: 'Fork at message', exact: true }).click();
    expect((await forkRequest).postDataJSON()).toMatchObject({ sourceChatId: seed.chatId,
      transcriptViewId: seed.transcriptViewId, upToOrdinal: seed.promptOrdinal });
    const response = await forkResponse;
    expect(response.ok()).toBe(true);
    const fork = await response.json();
    await page.waitForURL(url => url.pathname === `/chat/${fork.chat.id}`);
    await browserExpect(page.locator(`${DISPLAY_FEED}[aria-busy="false"]`)).toHaveCount(2);
    const history = await integration.client.getMessages(fork.chat.id);
    expect(history.messages.some(row => row.message.type === 'bash-tool-use')).toBe(false);
    await seed.wire.settle();
    expectNoHistoricalMembers(seed.wire);
  });
}, 120_000);
