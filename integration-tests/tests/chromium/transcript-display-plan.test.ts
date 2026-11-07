import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { liveClaudeRunRequest, liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { appendDisplayRun } from '../../support/transcript-display-fixture.js';
import { observeDisplayWire, waitForDisplayIdle } from '../../support/transcript-display-browser.js';

test('existing plan choices stay acknowledged without hydrating historical tool members', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  try {
    await withChromiumFixture('display-plan-consumer', async ({ page, integration }) => {
      const chatId = integration.newChatId();
      environment.model.scriptTurn([claudeText('Synthetic plan setup complete')]);
      const started = await integration.client.startChat(liveClaudeStartRequest({ chatId,
        projectPath: integration.dirs.project, command: 'Synthetic plan setup', permissionMode: 'bypassPermissions' }));
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await integration.restartGarcon({ beforeStart: async () => {
        await appendDisplayRun(integration.dirs.workspace, chatId, 1500);
      } });
      const wire = await observeDisplayWire(page);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await collapseCanonicalFilesWindow(page);
      await waitForDisplayIdle(page);

      async function propose(plan: string) {
        environment.model.scriptTurn([claudeToolUse('synthetic-plan-exit', 'ExitPlanMode', { plan })]);
        environment.model.scriptTurn([claudeText('Synthetic plan proposed')]);
        const turn = await integration.client.runChat(liveClaudeRunRequest({ chatId,
          command: `Propose ${plan}`, permissionMode: 'bypassPermissions' }));
        await integration.client.waitForTurnTerminal(chatId, turn.turnId);
        await browserExpect(page.getByRole('button', { name: 'Yes, bypass permissions', exact: true })).toBeVisible();
        await waitForDisplayIdle(page);
      }

      await propose('Synthetic plan for a new session');
      const beforeRevision = environment.model.markRequests();
      await browserExpect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
      const [dismissed] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/transcript-display/plan-dismiss')),
        page.getByRole('button', { name: 'Yes, new session + bypass', exact: true }).click(),
      ]);
      expect(dismissed.ok()).toBe(true);
      await browserExpect(page.getByRole('button', { name: 'Yes, bypass permissions', exact: true })).toHaveCount(0);
      const newChat = page.locator('[data-slot="new-chat-composer"]');
      await browserExpect(newChat.locator('textarea')).toHaveValue('Implement the following plan:\n\nSynthetic plan for a new session');
      if (await page.locator('[data-slot="directory-browser-dismiss"]').isVisible()) await page.keyboard.press('Escape');
      await page.locator('[data-slot="new-chat-form-content"] button[title="Close"]').click();
      await browserExpect(newChat).toHaveCount(0);
      await page.reload();
      await waitForDisplayIdle(page);
      await browserExpect(page.getByRole('button', { name: 'Yes, bypass permissions', exact: true })).toHaveCount(0);
      expect(environment.model.requestsSince(beforeRevision)).toEqual([]);

      const plan = 'Synthetic approved implementation plan';
      await propose(plan);
      const approval = environment.model.scriptHeldTurn([claudeText('Synthetic approved plan completed')]);
      const afterIndex = integration.client.markEvents();
      try {
        const [approvalDismissed] = await Promise.all([
          page.waitForResponse(response => response.url().endsWith('/transcript-display/plan-dismiss')),
          page.getByRole('button', { name: 'Yes, bypass permissions', exact: true }).click(),
        ]);
        expect(approvalDismissed.ok()).toBe(true);
        const request = await approval.requested;
        expect(request.lastUserText).toContain('User has approved your plan.');
        expect(request.lastUserText).toContain(`## Approved Plan:\n${plan}`);
        approval.release();
        await integration.client.waitForTurnTerminal(chatId, undefined, { afterIndex });
        await page.getByText('Synthetic approved plan completed', { exact: true }).waitFor();
      } finally { approval.release(); }
      await wire.settle();
      expect(wire.bodies().filter(row => (row.message.type === 'bash-tool-use' || row.message.type === 'tool-result')
        && row.message.toolId.startsWith('synthetic-display-'))).toEqual([]);
      expect(wire.requests).not.toContain('/api/v1/chats/messages');
      environment.model.assertSettled();
    }, undefined, { serverEnvironment: environment.serverEnvironment });
  } finally { environment.dispose(); }
}, 180_000);
