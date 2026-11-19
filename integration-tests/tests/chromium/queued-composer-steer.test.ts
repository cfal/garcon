import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import {
  parseSteerCommandRequest, type QueuedSteerCommandResponse, type SteerCommandResponse,
} from '../../../common/chat-command-contracts.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { ClaudeSessionStartGate } from '../../support/claude-session-start-gate.js';
import { Deferred } from '../../support/deferred.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

test('keeps a composer steer visible from submission through queue edits to its single committed echo', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  const gate = new ClaudeSessionStartGate();
  const held = environment.model.scriptHeldTurn([claudeText('Synthetic first reply.')]);
  environment.model.scriptTurn([claudeText('Synthetic guidance received.')]);
  try {
    await withChromiumFixture('queued-composer-steer', async ({ integration, page, assertNoBrowserErrors }) => {
      const { client } = integration;
      const chatId = integration.newChatId();
      const afterIndex = client.markEvents();
      const active = await client.startChat(liveClaudeStartRequest({
        chatId, projectPath: integration.executionDirs.project, command: 'Synthetic first turn.',
        permissionMode: 'bypassPermissions',
      }));
      const releasePost = new Deferred<void>();
      try {
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        await browserExpect(page.getByRole('button', { name: 'Queue message', exact: true })).toBeVisible();
        const editor = page.getByPlaceholder('Reply...', { exact: true });
        const endpoint = '**/api/v1/chats/steer';
        await page.route(endpoint, async route => {
          await releasePost.promise;
          await route.continue();
        }, { times: 1 });
        const requested = page.waitForRequest(endpoint);
        const text = 'Synthetic composer guidance.';
        await editor.fill(text);
        await editor.press('Control+Enter');
        const { clientMessageId } = parseSteerCommandRequest((await requested).postDataJSON());
        const bubble = page.locator(`[data-chat-row-id="optimistic:${clientMessageId}"]`);
        await browserExpect(editor).toHaveValue('');
        await browserExpect(bubble).toContainText(text);
        await browserExpect(bubble.getByLabel('Sending', { exact: true })).toBeInViewport();

        const response = page.waitForResponse(endpoint);
        releasePost.resolve();
        const queued = await response;
        expect(queued.status()).toBe(202);
        const receipt: SteerCommandResponse | QueuedSteerCommandResponse = await queued.json();
        if (receipt.delivery !== 'queued') throw new Error('Expected the steer to wait in the queue');
        const preview = page.locator('[data-queue-preview]');
        await browserExpect(preview).toHaveText(text);
        await browserExpect(bubble.getByLabel('Waiting to steer', { exact: true })).toBeInViewport();
        await browserExpect(bubble.getByLabel('Sending', { exact: true })).toHaveCount(0);

        const edited = 'Synthetic edited guidance.';
        await client.replaceQueued({ chatId, entryId: receipt.entryId, clientRequestId: crypto.randomUUID(),
          expectedRevision: 1, content: edited });
        await browserExpect(bubble).toContainText(edited);
        await browserExpect(preview).toHaveText(edited);
        const messages = async () => (await client.getMessages(chatId)).messages.filter(({ message }) =>
          message.type === 'user-message' && message.metadata?.clientMessageId === clientMessageId);
        expect(await messages()).toHaveLength(0);

        await gate.open();
        await held.requested;
        await client.waitForCommittedUserInput(chatId, edited, { afterIndex });
        const committed = page.locator('[data-chat-row-id]:not([data-chat-row-id^="optimistic:"])').filter({ hasText: edited });
        await browserExpect(committed).toBeInViewport();
        await browserExpect(bubble).toHaveCount(0);
        await browserExpect(preview).toHaveCount(0);
        expect(await messages()).toHaveLength(1);
        held.release();
        expect((await client.waitForTurnTerminal(chatId, active.turnId, { afterIndex })).type).toBe('agent-run-finished');
        environment.model.assertSettled();
        assertNoBrowserErrors();
      } finally {
        releasePost.resolve();
        await gate.open();
        held.release();
      }
    }, undefined, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: dirs => gate.install(dirs) });
  } finally {
    environment.dispose();
  }
}, 120_000);
