import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function dataUrl(mimeType: string, content: string): string {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
}

// Non-image attachments of any type reach the real Codex binary as files on
// disk that its shell tool reads.
describe('Codex file attachments against a scripted model', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('delivers spreadsheet and CSV attachments as readable files', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const sheetMarker = `SHEET_${crypto.randomUUID().replaceAll('-', '')}`;
    const csvMarker = `CSV_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_DONE_${crypto.randomUUID().replaceAll('-', '')}`;
    let paths: string[] = [];
    testEnvironment.model.scriptTurn((request) => {
      paths = [...request.lastUserText.matchAll(/^- (\S+\.(?:xlsx|csv))$/gm)].map((match) => match[1]!);
      if (paths.length !== 2) throw new Error(`Expected two attachment paths: ${request.lastUserText}`);
      return [codexExecCommandCall('call_read_files', `cat ${paths.join(' ')}`)];
    });
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-file-attachments', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat({
        ...liveCodexStartRequest({
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
      expect(requests).toHaveLength(2);
      expect(paths[0]).toEndWith('budget.xlsx');
      expect(paths[1]).toEndWith('table.csv');
      expect(requests[1].functionCallOutputs[0].output).toContain(sheetMarker);
      expect(requests[1].functionCallOutputs[0].output).toContain(csvMarker);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });
});
