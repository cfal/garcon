import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { codexFinalAnswerMessage } from '../../support/fake-codex-model.js';
import { ASK_USER_QUESTION_TEXT_MAX_BYTES } from '../../../common/ask-user-question-response.js';

test('Codex options and notes submit together and remain visible after reload on desktop and mobile', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withChromiumFixture('codex-question-notes', async ({ page, integration, assertNoBrowserErrors }) => {
      for (const width of [1440, 390]) {
        const chatId = integration.newChatId();
        const callId = `call-notes-${width}`;
        const text = 'Only tests\nKeep defaults.';
        environment.model.scriptTurn([{
          type: 'function_call', name: 'request_user_input', call_id: callId,
          arguments: JSON.stringify({ questions: [{
            id: 'mode', header: 'Mode', question: 'Which mode?',
            options: [{ label: 'Fast', description: 'Quick path' }, { label: 'Careful', description: 'Detailed path' }],
          }] }),
        }]);
        environment.model.scriptTurn((request) => {
          const output = request.functionCallOutputs.find((item) => item.callId === callId);
          expect(JSON.parse(output!.output)).toEqual({ answers: { mode: { answers: ['Careful', `user_note: ${text}`] } } });
          return [codexFinalAnswerMessage('NOTES_RECEIVED')];
        });
        const turn = await integration.client.startChat(liveCodexStartRequest({
          chatId, projectPath: integration.executionDirs.project, command: 'Ask which mode to use.',
        }));
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        const careful = page.getByRole('radio', { name: /Careful/ });
        await careful.check();
        const note = page.getByRole('textbox', { name: 'Notes (optional)' });
        const submit = page.getByRole('button', { name: 'Submit answer', exact: true });
        await note.fill('   ');
        await browserExpect(submit).toBeDisabled();
        for (const character of ['x', '\u00e9']) {
          const limit = ASK_USER_QUESTION_TEXT_MAX_BYTES / Buffer.byteLength(character);
          const oversized = character.repeat(limit + 1);
          await note.fill('');
          await note.focus();
          await page.keyboard.insertText(oversized);
          await browserExpect(note).toHaveValue(oversized);
          await browserExpect(submit).toBeDisabled();
        }
        await note.fill(text);
        await browserExpect(submit).toBeEnabled();
        await browserExpect(careful).toBeChecked();
        await browserExpect(page.getByRole('radio', { name: 'Other', exact: true })).not.toBeChecked();
        expect(await note.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
        await mkdir(artifacts, { recursive: true });
        await page.screenshot({ path: join(artifacts, `codex-question-notes-${width}.png`) });
        if (width === 1440) await submit.press('Enter');
        else await submit.click();
        await integration.client.waitForTurnTerminal(chatId, turn.turnId);
        await browserExpect(page.getByText(text, { exact: true })).toBeVisible();
        await page.reload();
        await browserExpect(careful).toBeChecked();
        await browserExpect(careful).toBeDisabled();
        await browserExpect(page.getByText(text, { exact: true })).toBeVisible();
        await browserExpect(submit).toHaveCount(0);
        assertNoBrowserErrors();
      }
      environment.model.assertSettled();
    }, undefined, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    await environment.dispose();
  }
}, 180_000);
