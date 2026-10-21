import { describe, expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function dataUrl(mimeType: string, content: string): string {
  return `data:${mimeType};base64,${Buffer.from(content).toString('base64')}`;
}

// Agents without their own file tools receive text attachments inline and
// refuse binary formats they cannot read.
describe('file attachment support for direct agents', () => {
  test('inlines CSV text, including the type Windows browsers declare for it', async () => {
    await withIntegrationFixture('file-attachment-direct-csv', async (fixture) => {
      const chatId = fixture.newChatId();
      const csvMarker = `CSV_${crypto.randomUUID().replaceAll('-', '')}`;
      const turn = await fixture.client.startChat({
        ...fixture.client.directStartRequest({
          chatId,
          content: 'Summarize the table.',
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.anthropic,
        }),
        images: [{
          name: 'table.csv',
          mimeType: 'application/vnd.ms-excel',
          data: dataUrl('application/vnd.ms-excel', `name,value\n${csvMarker},1`),
        }],
      });
      await fixture.client.waitForTurnTerminal(chatId, turn.turnId);

      const request = fixture.fakeProviders.anthropic.requests().at(-1);
      expect(request?.lastUserText).toContain('<attached-file name="table.csv" mime="text/csv">');
      expect(request?.lastUserText).toContain(csvMarker);
    });
  });

  test.each(['openAi', 'openAiResponses', 'anthropic'] as const)(
    'rejects a CSV too large for %s to receive whole before any provider request',
    async (agentKey) => {
      await withIntegrationFixture(`file-attachment-direct-large-csv-${agentKey}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const provider = {
          openAi: fixture.fakeProviders.openAi,
          openAiResponses: fixture.fakeProviders.openAiResponses,
          anthropic: fixture.fakeProviders.anthropic,
        }[agentKey];
        const requestCount = provider.requests().length;
        const csv = 'name,value\n' + 'row,1\n'.repeat(30_000);
        expect(await rejectionOf(fixture.client.startChat({
          ...fixture.client.directStartRequest({
            chatId,
            content: 'Summarize the table.',
            projectPath: fixture.dirs.project,
            agent: fixture.directAgents[agentKey],
          }),
          images: [{ name: 'large.csv', mimeType: 'text/csv', data: dataUrl('text/csv', csv) }],
        }))).toMatchObject({
          status: 422,
          body: { errorCode: 'UNSUPPORTED_AGENT' },
        });
        expect(provider.requests()).toHaveLength(requestCount);
      });
    },
  );

  test('rejects a spreadsheet before any provider request', async () => {
    await withIntegrationFixture('file-attachment-direct-xlsx', async (fixture) => {
      const chatId = fixture.newChatId();
      const requestCount = fixture.fakeProviders.anthropic.requests().length;
      expect(await rejectionOf(fixture.client.startChat({
        ...fixture.client.directStartRequest({
          chatId,
          content: 'Summarize the sheet.',
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.anthropic,
        }),
        images: [{ name: 'budget.xlsx', mimeType: XLSX_MIME, data: dataUrl(XLSX_MIME, 'sheet') }],
      }))).toMatchObject({
        status: 422,
        body: { errorCode: 'UNSUPPORTED_AGENT' },
      });
      expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(requestCount);
    });
  });
});
