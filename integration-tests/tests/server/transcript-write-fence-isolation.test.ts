import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('transcript write-fence isolation', () => {
  test('[TLV5-L11.05-SERVER-01] keeps durable history readable after a write failure', async () => {
    await withIntegrationFixture('transcript-write-fence-isolation', async (fixture) => {
      const chatId = fixture.newChatId();
      const initialTurn = await fixture.client.startDirectChat({
        chatId,
        content: 'durable-before-write-failure',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, initialTurn.turnId);
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        'durable-before-write-failure',
      ]);

      const ledgerPath = join(
        fixture.dirs.workspace,
        'transcript-ledgers',
        chatId,
        'ledger.sqlite',
      );
      const db = new Database(ledgerPath);
      db.exec(`
        CREATE TRIGGER inject_transcript_write_failure
        BEFORE INSERT ON transcript_rows
        BEGIN
          SELECT RAISE(FAIL, 'injected transcript write failure');
        END
      `);
      db.close();

      await expect(fixture.client.runDirectChat({
        chatId,
        content: 'rejected-during-write-failure',
        agent: fixture.directAgents.openAi,
      })).rejects.toThrow();
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        'durable-before-write-failure',
      ]);

      const cleanup = new Database(ledgerPath);
      cleanup.exec('DROP TRIGGER inject_transcript_write_failure');
      cleanup.close();

      await expect(fixture.client.runDirectChat({
        chatId,
        content: 'rejected-after-write-fence',
        agent: fixture.directAgents.openAi,
      })).rejects.toThrow();
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        'durable-before-write-failure',
      ]);
    });
  });
});
