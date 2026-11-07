import { expect } from 'bun:test';
import type { Page, Route } from 'playwright';
import { expect as browserExpect } from 'playwright/test';
import { parseDisplayWindowResponse, type DisplayUnavailable } from '../../common/transcript-display-contract.js';
import type { ChatInputCommittedMessage } from '../../common/transcript-display-events.js';
import type { ChromiumFixture } from './chromium-fixture.js';
import { collapseCanonicalFilesWindow } from './chromium-workspace.js';
import { claudeText, claudeToolUse } from './fake-claude-model.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from './live-claude.js';
import type { ScriptedClaudeTestEnvironment } from './scripted-claude.js';
import { createDisplayChat } from './transcript-display-fixture.js';
import { DISPLAY_FEED, observeDisplayWire, waitForDisplayIdle } from './transcript-display-browser.js';

async function interceptUnavailableWindow(page: Page, chatId: string, kind: 'lagging' | 'failed') {
  let responses = 0;
  const handler = async (route: Route) => {
    if (route.request().postDataJSON().chatId !== chatId) return route.continue();
    const response = await route.fetch();
    const reply = parseDisplayWindowResponse(await response.json());
    const identity = reply.kind === 'available' ? reply.certificate : reply;
    const unavailable = {
      kind, serverInstanceId: identity.serverInstanceId, chatId,
      transcriptViewId: identity.transcriptViewId, policyRevision: identity.policyRevision,
      profileKey: identity.profileKey, bashRevision: identity.bashRevision,
      sourceHead: reply.sourceHead, preparedThrough: 0,
      errorCode: kind === 'failed' ? 'DISPLAY_STORE_INVALID' : null,
      retryAfterMs: kind === 'failed' ? null : 1000,
    } satisfies DisplayUnavailable;
    responses++;
    await route.fulfill({ response, json: unavailable });
  };
  const path = '**/api/v1/chats/transcript-display/window';
  await page.route(path, handler);
  return { get responses() { return responses; }, release: () => page.unroute(path, handler) };
}

interface InputCapture { active: boolean; frames: number; counts: number[] }

export async function verifyOptimisticProjectionLag(fixture: ChromiumFixture) {
  const { page, integration } = fixture;
  const chatId = await createDisplayChat(integration);
  await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
  await collapseCanonicalFilesWindow(page);
  await waitForDisplayIdle(page);
  const lag = await interceptUnavailableWindow(page, chatId, 'lagging');
  const content = 'Synthetic optimistic input during preparation';
  const held = integration.fakeProviders.openAi.holdNext({ lastUserText: content });
  const afterIndex = integration.client.markEvents();
  try {
    await page.locator('[data-composer] textarea').fill(content);
    await page.locator('[data-composer]').getByRole('button', { name: 'Send message', exact: true }).click();
    await held.received;
    const committed = await integration.client.waitForEvent(
      (message): message is ChatInputCommittedMessage => message.type === 'chat-input-committed' && message.chatId === chatId,
      'optimistic input commit before display readiness', { afterIndex });
    if (committed.type !== 'chat-input-committed') throw new Error('Missing exact input acknowledgement.');
    const input = page.locator(`${DISPLAY_FEED} [data-chat-message-type="user-message"]`).filter({ hasText: content });
    await browserExpect(input).toHaveCount(1);
    await browserExpect(input).toHaveAttribute('data-chat-row-id', /^optimistic:/);
    await browserExpect.poll(() => lag.responses).toBeGreaterThan(0);
    await page.evaluate(content => {
      const capture: InputCapture = { active: true, frames: 0, counts: [] };
      Object.assign(window, { __displayInputCapture: capture });
      const sample = () => {
        if (!capture.active) return;
        capture.frames++;
        const count = [...document.querySelectorAll('[data-chat-message-type="user-message"]')]
          .filter(row => row.textContent?.includes(content)).length;
        if (count !== 1) capture.counts.push(count);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, content);
    held.releaseText('Synthetic optimistic turn completed');
    await integration.client.waitForTurnTerminal(chatId, undefined, { afterIndex });
    await browserExpect(input).toHaveAttribute('data-chat-row-id', /^optimistic:/);
    await lag.release();
    await browserExpect(input).toHaveAttribute('data-chat-row-id', `${committed.transcriptViewId}:${committed.ordinal}`);
    await waitForDisplayIdle(page);
    const capture = await page.evaluate(() => {
      const capture = (window as unknown as { __displayInputCapture: InputCapture }).__displayInputCapture;
      capture.active = false;
      return capture;
    });
    expect(capture.frames).toBeGreaterThan(2);
    expect(capture.counts).toEqual([]);
  } finally {
    held.releaseEcho();
    await lag.release();
  }
}

export async function verifyFailedDisplayControlsAndLiveWire(fixture: ChromiumFixture, environment: ScriptedClaudeTestEnvironment) {
  const { page, integration } = fixture;
  const chatId = integration.newChatId();
  environment.model.scriptTurn([claudeToolUse('synthetic-display-question', 'AskUserQuestion', {
    questions: [{ question: 'Choose a synthetic store', header: 'Store', multiSelect: false,
      options: [{ label: 'SQLite', description: 'Embedded store' }, { label: 'Postgres', description: 'Server store' }] }],
  })]);
  environment.model.scriptTurn([claudeText('Synthetic permission completed')]);
  const started = await integration.client.startChat(liveClaudeStartRequest({ chatId,
    projectPath: integration.dirs.project, command: 'Synthetic display failure permission', permissionMode: 'bypassPermissions' }));
  await integration.client.waitForTransientPermission(chatId, () => true);
  const failure = await interceptUnavailableWindow(page, chatId, 'failed');
  const retryPath = '**/api/v1/chats/transcript-display/retry';
  const allowRetry = async (route: Route) => {
    if (route.request().postDataJSON().chatId === chatId) await failure.release();
    await route.continue();
  };
  await page.route(retryPath, allowRetry);
  const wire = await observeDisplayWire(page);
  try {
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    await browserExpect.poll(() => failure.responses).toBeGreaterThan(0);
    await browserExpect(page.locator(DISPLAY_FEED).getByText('Failed to refresh messages', { exact: true })).toBeVisible();
    await browserExpect(page.locator(DISPLAY_FEED).getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: /SQLite/ }).check();
    await page.getByRole('button', { name: /Submit answer/ }).click();
    expect((await integration.client.waitForTurnTerminal(chatId, started.turnId)).type).toBe('agent-run-finished');
    await browserExpect(page.getByRole('button', { name: /Submit answer/ })).toHaveCount(0);
    await wire.settle();
    expect(wire.bodies()).toEqual([]);
    const [retried] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/transcript-display/retry')
        && response.request().postDataJSON().chatId === chatId),
      page.locator(DISPLAY_FEED).getByRole('button', { name: 'Retry', exact: true }).click(),
    ]);
    expect(retried.ok()).toBe(true);
    await page.getByText('Synthetic permission completed', { exact: true }).waitFor();
    await waitForDisplayIdle(page);
    await wire.settle();
    expect(wire.requests.filter(path => path.endsWith('/transcript-display/retry'))).toHaveLength(1);
  } finally {
    await page.unroute(retryPath, allowRetry);
    await failure.release();
  }
  const httpStart = wire.http.length, wsStart = wire.ws.length;
  const pairs = 60;
  environment.model.scriptTurn(Array.from({ length: pairs }, (_, index) =>
    claudeToolUse(`synthetic-display-live-${index}`, 'Bash', { command: "printf '%02048d' 0", description: 'Synthetic output' })));
  environment.model.scriptTurn([claudeText('Synthetic collapsed run completed')]);
  const turn = await integration.client.runChat(liveClaudeRunRequest({ chatId,
    command: 'Synthetic live collapsed tool run', permissionMode: 'bypassPermissions' }));
  expect((await integration.client.waitForTurnTerminal(chatId, turn.turnId, { timeoutMs: 90_000 })).type).toBe('agent-run-finished');
  await browserExpect(page.locator('[data-chat-tool-group]')).toHaveAttribute('data-chat-tool-group-count', String(pairs));
  await page.getByText('Synthetic collapsed run completed', { exact: true }).waitFor();
  await waitForDisplayIdle(page);
  await wire.settle();
  expect(wire.bodies().filter(row => (row.message.type === 'bash-tool-use' || row.message.type === 'tool-result')
    && row.message.toolId.startsWith('synthetic-display-live-'))).toEqual([]);
  const httpBytes = wire.http.slice(httpStart).reduce((sum, reply) => sum + reply.bytes, 0);
  const wsBytes = wire.ws.slice(wsStart).filter(event => event.chatId === chatId).reduce((sum, event) => sum + event.bytes, 0);
  expect(httpBytes + wsBytes).toBeLessThan(pairs * 2048);
  expect(wire.requests).not.toContain('/api/v1/chats/messages');
  console.log(JSON.stringify({ liveCollapsedPairs: pairs, omittedResultBytes: pairs * 2048, httpBytes, wsBytes }));
  environment.model.assertSettled();
}
