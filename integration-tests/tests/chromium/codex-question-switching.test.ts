import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { parseServerWsMessage } from '../../../common/ws-events.js';

for (const width of [1440, 390]) {
  test(`question and queue updates preserve the chat-switching surface at ${width}px`, async () => {
    const environment = await startScriptedCodexTestEnvironment();
    try {
      await withChromiumFixture(`codex-question-switching-${width}`, async ({ page, integration }, phase) => {
        const { client, executionDirs } = integration;
        const idleId = integration.newChatId();
        const idleTurn = await client.startDirectChat({
          chatId: idleId, projectPath: executionDirs.project, agent: integration.directAgents.openAi,
          content: 'Synthetic reading chat\n\n' + 'Synthetic reading paragraph.\n\n'.repeat(80),
        });
        await client.waitForTurnTerminal(idleId, idleTurn.turnId);
        const questionId = integration.newChatId();
        environment.model.scriptTurn([{
          type: 'function_call', name: 'request_user_input', call_id: 'call-switching',
          arguments: JSON.stringify({ questions: [{
            id: 'mode', header: 'Mode', question: 'Which mode?',
            options: [{ label: 'Fast', description: 'Quick path' }, { label: 'Careful', description: 'Detailed path' }],
          }] }),
        }]);
        environment.model.scriptTurn([codexFinalAnswerMessage('SYNTHETIC_BACKGROUND_COMPLETE')]);
        const turn = await client.startChat(liveCodexStartRequest({
          chatId: questionId, projectPath: executionDirs.project, command: 'Synthetic question switching',
        }));
        const permission = await client.waitForTransientPermission(questionId, () => true, { timeoutMs: 90_000 });
        await client.enqueueNew(questionId, 'Synthetic queued work');
        await client.pauseQueue(questionId);
        let observedFinished = false;
        let emptyQueueVersion = -1;
        page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
          const message = parseServerWsMessage(JSON.parse(payload.toString()));
          if (message?.type === 'agent-run-finished' && message.chatId === questionId && message.turnId === turn.turnId) {
            observedFinished = true;
          }
          if (message?.type === 'chat-execution-control-updated' && message.chatId === questionId
            && message.control.queue.entries.length === 0) {
            emptyQueueVersion = message.control.version;
          }
        }));
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${integration.garcon.baseUrl}/chat/${questionId}`);
        const composer = page.locator('[data-composer]:visible');
        const editor = composer.locator('textarea');
        const dock = page.locator('[data-conversation-panel-composer-anchor="true"] [data-conversation-panel-status-dock]');
        const viewport = page.locator('[data-chat-scroll-viewport]:visible');
        const originalEditor = await editor.elementHandle();
        const composerTop = (await composer.boundingBox())!.y;
        const dockTop = await dock.evaluate(element => element.getBoundingClientRect().y);
        await editor.fill('Synthetic question composer draft');
        await page.getByRole('radio', { name: /Careful/ }).check();
        await page.getByRole('textbox', { name: 'Notes (optional)' }).fill('Temporary question note');

        async function selectChat(chatId: string) {
          if (width === 390) await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page.locator(`[data-sidebar-virtual-row="${chatId}"] button`).first().click();
          await page.waitForURL(`**/chat/${chatId}`);
          await browserExpect(page.locator('[data-conversation-panel-composer-anchor="true"]'))
            .toHaveAttribute('data-conversation-panel-chat-id', chatId);
          if (width === 390) await browserExpect(page.getByRole('dialog', { name: 'Chats', exact: true })).toBeHidden();
          expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true);
          expect((await composer.boundingBox())!.y).toBe(composerTop);
          expect(await dock.evaluate(element => element.getBoundingClientRect().y)).toBe(dockTop);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }

        phase('rapidly switching pending-question and scrolled idle chats');
        await selectChat(idleId);
        await editor.fill('Synthetic reading composer draft');
        await browserExpect.poll(() => viewport.evaluate(element =>
          element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
        await viewport.hover();
        await page.mouse.wheel(0, -500);
        await browserExpect.poll(() => viewport.evaluate(element =>
          element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(400);
        await browserExpect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
        const readingTop = await viewport.evaluate(element => element.scrollTop);
        for (let index = 0; index < 3; index++) {
          await selectChat(questionId);
          await browserExpect(editor).toHaveValue('Synthetic question composer draft');
          await browserExpect(page.getByText('Synthetic queued work', { exact: true })).toBeVisible();
          await browserExpect(page.getByRole('button', { name: 'Submit answer', exact: true })).toBeDisabled();
          await browserExpect(page.getByRole('textbox', { name: 'Notes (optional)' })).toHaveCount(0);
          await selectChat(idleId);
          await browserExpect(editor).toHaveValue('Synthetic reading composer draft');
          await browserExpect(page.getByText('Synthetic queued work', { exact: true })).toHaveCount(0);
          await browserExpect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0);
        }

        phase('receiving background resolution and queue updates without stealing focus or scroll');
        await editor.focus();
        await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(4, 4));
        await client.sendPermissionDecision({
          chatId: questionId, clientRequestId: crypto.randomUUID(),
          permissionOccurrenceId: permission.permissionOccurrenceId, allow: true, alwaysAllow: false,
          response: { type: 'ask-user-question-response', outcome: 'answered', answers: [{
            questionId: 'mode', selectedOptionIds: ['option-1'], text: 'Synthetic background note',
          }] },
        });
        await client.waitForTurnTerminal(questionId, turn.turnId);
        const cleared = await client.clearQueue(questionId);
        await browserExpect.poll(() => observedFinished && emptyQueueVersion >= cleared.control.version).toBe(true);
        await page.evaluate(() => new Promise<void>(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await browserExpect(page.locator('[data-conversation-panel-composer-anchor="true"]'))
          .toHaveAttribute('data-conversation-panel-chat-id', idleId);
        await browserExpect(editor).toBeFocused();
        expect(await editor.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(4);
        expect(await viewport.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0);
        await browserExpect(viewport).not.toContainText('SYNTHETIC_BACKGROUND_COMPLETE');
        await selectChat(questionId);
        await browserExpect(viewport).toContainText('SYNTHETIC_BACKGROUND_COMPLETE');
        await browserExpect(page.getByText('Synthetic background note', { exact: true })).toBeVisible();
        await browserExpect(page.getByRole('radio', { name: /Careful/ })).toBeChecked();
        await browserExpect(page.getByRole('radio', { name: /Careful/ })).toBeDisabled();
        await browserExpect(page.getByRole('button', { name: 'Submit answer', exact: true })).toHaveCount(0);
        await browserExpect(page.getByText('Synthetic queued work', { exact: true })).toHaveCount(0);
        await browserExpect(page.locator('[data-slot="chat-processing-status"]')).toHaveCount(0);
        await browserExpect(editor).toHaveValue('Synthetic question composer draft');
        const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `codex-question-switching-${width}.png`) });
        await selectChat(idleId);
        await browserExpect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0);
        environment.model.assertSettled();
      }, undefined, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
    } finally {
      await environment.dispose();
    }
  }, 180_000);
}
