import { expect, test } from 'bun:test';
import { appendFile, readFile } from 'node:fs/promises';
import { userContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains, waitForVisibleResponse } from '../../support/live-agent.js';
import { rejectionOf } from '../../support/promise-assertions.js';
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
      await fixture.client.ping();
      let reloading = true;
      let replies = 0;
      let maxRoundTripMs = 0;
      const reload = fixture.client.reloadChat(chatId).finally(() => { reloading = false; });
      const probe = (async () => {
        while (reloading) {
          const sentAt = performance.now();
          await fixture.client.ping();
          maxRoundTripMs = Math.max(maxRoundTripMs, performance.now() - sentAt);
          if (reloading) replies += 1;
          await Bun.sleep(25);
        }
      })();
      const [reloaded] = await Promise.all([reload, probe]);
      expect(reloaded.lastOrdinal).toBeGreaterThan(ROWS);
      expect(replies).toBeGreaterThan(0);
      // Matches the shared-runner allowance in long-chat-responsiveness.test.ts.
      expect(maxRoundTripMs).toBeLessThan(500);
      expect(userContents((await fixture.client.getMessages(chatId)).messages).at(-1))
        .toBe(`Synthetic request ${ROWS - 1}`);

      const timestamp = '2026-01-02T00:00:00.000Z';
      await appendFile(native.path, [
        JSON.stringify({ type: 'compaction', id: 'synthetic-compaction', parentId, timestamp,
          summary: 'Synthetic summary', firstKeptEntryId: `synthetic-${ROWS - 2}`, tokensBefore: ROWS }),
        JSON.stringify({ type: 'context_edit', id: 'synthetic-edit', parentId: 'synthetic-compaction', timestamp,
          targetId: `synthetic-${ROWS - 1}`, replacement: { content: 'Synthetic edited request' } }),
        '',
      ].join('\n'));
      await fixture.client.reloadChat(chatId);
      const compacted = await fixture.client.getMessages(chatId);
      expect(userContents(compacted.messages)).toEqual([
        `Synthetic request ${ROWS - 2}`, 'Synthetic edited request',
      ]);
      await appendFile(native.path, [
        JSON.stringify({ type: 'message', id: 'malformed', parentId: 'synthetic-edit', timestamp, message: null }),
        JSON.stringify({ type: 'compaction', id: 'malformed-compaction', parentId: 'malformed', timestamp,
          summary: 'Synthetic malformed summary', firstKeptEntryId: 'missing', tokensBefore: ROWS }),
        '',
      ].join('\n'));
      expect(await rejectionOf(fixture.client.reloadChat(chatId))).toMatchObject({
        response: { code: 'HISTORY_LOAD_FAILED' },
      });
      const preserved = await fixture.client.getMessages(chatId);
      expect(preserved.transcriptViewId).toBe(compacted.transcriptViewId);
      expect(preserved.messages).toEqual(compacted.messages);
      environment.model.assertSettled();
    }, { serverEnvironment: environment.serverEnvironment, prepareWorkspace: environment.prepareWorkspace });
  } finally {
    environment.dispose();
  }
}, 120_000);
