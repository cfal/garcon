import { expect, test } from 'bun:test';
import { appendFile, readFile } from 'node:fs/promises';
import { userContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains, waitForVisibleResponse } from '../../support/live-agent.js';
import { piNativeSession, scriptedPiStartRequest, startScriptedPiTestEnvironment } from '../../support/scripted-pi.js';

const ROWS = 30_000;

test('reloads a long Pi active path and retains compaction edits while serving other requests', async () => {
  const environment = startScriptedPiTestEnvironment();
  environment.model.scriptTurn([chatCompletionsText('synthetic seed response')]);
  try {
    await withIntegrationFixture('pi-long-history', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'synthetic seed request',
      }));
      await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId,
        marker: 'synthetic seed response', afterIndex: cursor });
      await reloadUntilNativeContains(fixture, chatId, 'synthetic seed response');
      const native = await piNativeSession(fixture, chatId);
      const existing = (await readFile(native.path, 'utf8')).trimEnd();
      let parentId = JSON.parse(existing.split('\n').at(-1)!).id as string;
      const lines: string[] = [];
      for (let index = 0; index < ROWS; index += 1) {
        const id = `synthetic-${index}`;
        const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString();
        lines.push(JSON.stringify({ type: 'message', id, parentId, timestamp,
          message: { role: 'user', content: `Synthetic request ${index}`, timestamp: Date.parse(timestamp) } }));
        parentId = id;
      }
      await appendFile(native.path, `\n${lines.join('\n')}\n`);
      let probing = true;
      let replies = 0;
      const probe = (async () => {
        while (probing) {
          await fixture.client.ping();
          replies += 1;
          await Bun.sleep(10);
        }
      })();
      try {
        const reloaded = await fixture.client.reloadChat(chatId);
        expect(reloaded.lastOrdinal).toBeGreaterThan(ROWS);
        expect(userContents((await fixture.client.getMessages(chatId)).messages).at(-1))
          .toBe(`Synthetic request ${ROWS - 1}`);
      } finally {
        probing = false;
        await probe;
      }
      expect(replies).toBeGreaterThan(1);

      const timestamp = '2026-01-02T00:00:00.000Z';
      await appendFile(native.path, [
        JSON.stringify({ type: 'compaction', id: 'synthetic-compaction', parentId, timestamp,
          summary: 'Synthetic summary', firstKeptEntryId: `synthetic-${ROWS - 2}`, tokensBefore: ROWS }),
        JSON.stringify({ type: 'context_edit', id: 'synthetic-edit', parentId: 'synthetic-compaction', timestamp,
          targetId: `synthetic-${ROWS - 1}`, replacement: { content: 'Synthetic edited request' } }),
        '',
      ].join('\n'));
      await fixture.client.reloadChat(chatId);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        `Synthetic request ${ROWS - 2}`, 'Synthetic edited request',
      ]);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);
