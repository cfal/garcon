import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { parseServerWsMessage } from '../../../common/ws-events.js';
import { ASK_USER_QUESTION_TEXT_MAX_BYTES } from '../../../common/ask-user-question-response.js';

for (const width of [1440, 390]) {
  test(`async answers preserve independent drafts and chat surfaces at ${width}px`, async () => {
    const environment = await startScriptedCodexTestEnvironment({ supportedTools: ['request_user_input_async'] });
    environment.model.scriptTurn([{ type: 'function_call', name: 'request_user_input_async', call_id: 'call-browser-async',
      arguments: JSON.stringify({ questions: [{ title: 'Which environment?', options: ['Staging', 'Production'] }, { title: 'Deadline?' }] }) }]);
    const held = environment.model.scriptHeldStreamTurn([codexFinalAnswerMessage('UNUSED_INITIAL_REPLY')]);
    const steered = environment.model.scriptHeldTurn([codexFinalAnswerMessage('ASYNC_BACKGROUND_COMPLETE')]);
    const interrupted = environment.model.scriptHeldStreamTurn([codexFinalAnswerMessage('UNUSED_INTERRUPTED_REPLY')]);
    environment.model.scriptTurn([codexFinalAnswerMessage('ASYNC_BROWSER_COMPLETE')]);
    try {
      await withChromiumFixture(`async-questions-${width}`, async ({ page, integration, withExpectedConsoleErrors }, phase) => {
        const { client } = integration;
        const readingId = integration.newChatId();
        const readingTurn = await client.startDirectChat({ chatId: readingId, projectPath: integration.executionDirs.project,
          agent: integration.directAgents.openAi, content: 'Synthetic reading paragraph.\n\n'.repeat(80) });
        await client.waitForTurnTerminal(readingId, readingTurn.turnId);
        const chatId = integration.newChatId();
        const turn = await client.startChat(liveCodexStartRequest({ chatId, projectPath: integration.executionDirs.project, command: 'Ask for environment and deadline.' }));
        await held.requested;
        let observedFinished = false;
        page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
          const message = parseServerWsMessage(JSON.parse(payload.toString()));
          if (message?.type === 'agent-run-finished' && message.chatId === chatId && message.turnId === turn.turnId) observedFinished = true;
        }));
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        const composer = page.locator('[data-composer]:visible');
        const editor = composer.locator('textarea');
        const viewport = page.locator('[data-chat-scroll-viewport]:visible');
        const originalEditor = await editor.elementHandle();
        await editor.fill('Independent composer draft');
        await page.getByRole('radio', { name: 'Production', exact: true }).check();
        const deadline = page.getByRole('textbox', { name: 'Deadline?', exact: true });
        for (const character of ['x', '\u00e9']) {
          const limit = ASK_USER_QUESTION_TEXT_MAX_BYTES / Buffer.byteLength(character);
          const oversized = character.repeat(limit + 1);
          await deadline.fill('');
          await deadline.focus();
          await page.keyboard.insertText(oversized);
          await browserExpect(deadline).toHaveValue(oversized);
          await browserExpect(page.getByRole('button', { name: 'Send answer', exact: true }).nth(1)).toBeDisabled();
        }
        await deadline.fill('Friday afternoon');
        const questions = page.locator('[data-async-questions]');
        const card = questions.locator('[data-slot="chat-event-card"]');
        await browserExpect(card).toHaveCount(1);
        await browserExpect(card.getByText('Question', { exact: true })).toBeVisible();
        const prompts = card.getByRole('region', { name: 'Question', exact: true });
        await browserExpect(prompts).toHaveCount(2);
        expect(await prompts.first().evaluate(element => {
          const style = getComputedStyle(element);
          return { beforeDivider: style.paddingBottom, afterDivider: style.marginBottom, divider: style.borderBottomWidth };
        })).toEqual({ beforeDivider: '12px', afterDivider: '12px', divider: '1px' });
        expect(await prompts.last().evaluate(element => getComputedStyle(element).paddingBottom)).toBe('0px');
        const promptColor = await card.getByText('Which environment?', { exact: true }).evaluate(element => getComputedStyle(element).color);
        await card.getByRole('button', { name: 'Dismiss question', exact: true }).first().click();
        expect(await card.getByText('Which environment?', { exact: true }).evaluate(element => getComputedStyle(element).color)).toBe(promptColor);
        await browserExpect(deadline).toHaveValue('Friday afternoon');
        await card.getByRole('button', { name: 'Reply', exact: true }).click();
        await browserExpect(page.getByRole('radio', { name: 'Production', exact: true })).toBeChecked();
        const composerTop = (await composer.boundingBox())!.y;

        async function selectChat(id: string) {
          if (width === 390) await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page.locator(`[data-sidebar-virtual-row="${id}"] button`).first().click();
          await page.waitForURL(`**/chat/${id}`);
          await browserExpect(page.locator('[data-conversation-panel-composer-anchor="true"]')).toHaveAttribute('data-conversation-panel-chat-id', id);
          if (width === 390) await browserExpect(page.getByRole('dialog', { name: 'Chats', exact: true })).toBeHidden();
          expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true);
          expect((await composer.boundingBox())!.y).toBe(composerTop);
        }

        phase('retaining async drafts across rapid chat switches');
        for (let index = 0; index < 3; index++) {
          await selectChat(readingId);
          await selectChat(chatId);
          await browserExpect(editor).toHaveValue('Independent composer draft');
          await browserExpect(page.getByRole('radio', { name: 'Production', exact: true })).toBeChecked();
          await browserExpect(page.getByRole('textbox', { name: 'Deadline?', exact: true })).toHaveValue('Friday afternoon');
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const artifacts = join(import.meta.dir, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `async-questions-${width}.png`), fullPage: true });

        phase('steering without consuming the composer or the second question');
        await withExpectedConsoleErrors(['Failed to load resource: the server responded with a status of 409 (Conflict)'], async () => {
          await page.getByRole('button', { name: 'Send answer', exact: true }).first().click();
          await browserExpect(page.getByText('Sent to active turn', { exact: true })).toBeVisible();
        });
        await steered.requested;
        await browserExpect(editor).toHaveValue('Independent composer draft');
        await browserExpect(page.getByRole('textbox', { name: 'Deadline?', exact: true })).toHaveValue('Friday afternoon');
        await selectChat(readingId);
        await editor.fill('Reading composer draft');
        await viewport.hover();
        await page.mouse.wheel(0, -400);
        await browserExpect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(300);
        const readingTop = await viewport.evaluate(element => element.scrollTop);
        await editor.focus();
        held.release();
        steered.release();
        await browserExpect.poll(() => observedFinished).toBe(true);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await browserExpect(editor).toBeFocused();
        expect(await viewport.evaluate(element => element.scrollTop)).toBeCloseTo(readingTop, 0);

        phase('answering the remaining question after turn completion');
        await selectChat(chatId);
        await browserExpect(editor).toHaveValue('Independent composer draft');
        const declinedInput = 'DECLINED_RESEND_INPUT';
        const stoppedTurn = await client.runChat({ chatId, clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(), command: declinedInput });
        await interrupted.requested;
        await client.stopChat({ chatId, clientRequestId: crypto.randomUUID() });
        await client.waitForTurnTerminal(chatId, stoppedTurn.turnId);
        await page.getByRole('button', { name: `Don't resend ${declinedInput}`, exact: true }).click();
        await page.getByRole('textbox', { name: 'Deadline?', exact: true }).press('Enter');
        await browserExpect(page.getByText('ASYNC_BROWSER_COMPLETE', { exact: true })).toBeVisible();
        expect((await client.getExecutionControl(chatId)).queue.entries).toEqual([]);
        expect(environment.model.requests()[2].lastUserText).toContain('"answer":"Production"');
        expect(environment.model.requests()[4].lastUserText).toContain('"answer":"Friday afternoon"');
        expect(environment.model.requests()[4].lastUserText).not.toContain(declinedInput);
        const recorded = await client.getMessages(chatId);
        expect(recorded.messages.filter(entry => entry.message.type === 'user-message'
          && entry.message.metadata?.questionReply?.answer === 'Friday afternoon')).toHaveLength(1);
        environment.model.assertSettled();
      }, undefined, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
    } finally {
      held.release();
      steered.release();
      interrupted.release();
      await environment.dispose();
    }
  }, 150_000);
}
