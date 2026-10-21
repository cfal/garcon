import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function dataUrl(mimeType: string, content: string): string {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
}

// Spreadsheets reach the real Claude CLI as files on disk that its own tools
// read, while CSV stays inline prompt text.
describe('Claude file attachments against a scripted model', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  afterEach(() => {
    environment?.model.reset();
  });

  test('delivers a spreadsheet as a readable file and a CSV as inline text', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sheetMarker = `SHEET_${crypto.randomUUID().replaceAll('-', '')}`;
    const csvMarker = `CSV_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_DONE_${crypto.randomUUID().replaceAll('-', '')}`;
    let sheetPath = '';
    testEnvironment.model.scriptTurn((request) => {
      sheetPath = request.lastUserText.match(/^- (\S+budget\.xlsx) \(original name: "budget\.xlsx"\)$/m)?.[1] ?? '';
      if (!sheetPath) throw new Error(`No spreadsheet path in prompt: ${request.lastUserText}`);
      return [claudeToolUse('toolu_read_sheet', 'Bash', { command: `cat ${sheetPath}` })];
    });
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-file-attachments', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat({
        ...liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: 'Summarize the attached files.',
          permissionMode: 'bypassPermissions',
        }),
        images: [
          { name: 'budget.xlsx', mimeType: XLSX_MIME, data: dataUrl(XLSX_MIME, sheetMarker) },
          { name: 'table.csv', mimeType: 'text/csv', data: dataUrl('text/csv', `name,value\n${csvMarker},1`) },
        ],
      });
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const requests = testEnvironment.model.requests();
      expect(requests[0].lastUserText).toContain('<attached-file name="table.csv" mime="text/csv">');
      expect(requests[0].lastUserText).toContain(csvMarker);
      expect(requests[0].lastUserText).not.toContain(sheetMarker);
      const followUp = requests.find((request) =>
        request.toolResults.some((toolResult) =>
          toolResult.toolUseId === 'toolu_read_sheet' && toolResult.content.includes(sheetMarker)));
      if (!followUp) throw new Error('The spreadsheet file was not readable by the Claude tool.');
      // Cleanup follows turn completion, which can publish the reply first.
      const deadline = Date.now() + 5_000;
      while (await Bun.file(sheetPath).exists() && Date.now() < deadline) await Bun.sleep(25);
      expect(await Bun.file(sheetPath).exists()).toBe(false);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });
});
