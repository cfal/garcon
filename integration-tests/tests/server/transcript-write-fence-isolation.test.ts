import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AgentRunFailedMessage } from '../../../common/ws-events.js';
import { join } from 'node:path';
import { userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf, throwingRejectionOf } from '../../support/promise-assertions.js';

describe('transcript write-fence isolation', () => {
  test('pauses a queued turn after terminal storage fails and preserves its successor', async () => {
    await withIntegrationFixture('queued-turn-terminal-write-failure', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'first-before-storage-failure' });
      const queued = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'queued-before-storage-failure' });
      const accepted = await fixture.client.startDirectChat({
        chatId, content: 'first-before-storage-failure',
        projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await first.received;
      const entry = await fixture.client.enqueueNew(chatId, 'queued-before-storage-failure');
      await fixture.client.enqueueNew(chatId, 'successor-after-storage-failure');
      first.releaseEcho();
      await fixture.client.waitForTurnTerminal(chatId, accepted.turnId);
      await queued.received;

      const db = new Database(join(fixture.dirs.workspace, 'transcript-ledgers', chatId, 'ledger.sqlite'));
      db.exec(`
        CREATE TRIGGER fail_queued_terminal BEFORE INSERT ON transcript_rows
        WHEN NEW.kind = 'run-ended'
        BEGIN SELECT RAISE(FAIL, 'injected queued terminal failure'); END
      `);
      db.close();
      const cursor = fixture.client.markEvents();
      queued.releaseEcho();
      const failed = await fixture.client.waitForTurnTerminal(chatId, undefined, { afterIndex: cursor, timeoutMs: 3000 });
      expect(failed.type).toBe('agent-run-failed');
      const control = await fixture.client.getExecutionControl(chatId);
      expect(control.queue.pause).toMatchObject({ kind: 'queued-turn-failed', entryId: entry.entryId });
      expect(control.queue.entries.map(next => next.content)).toEqual(['successor-after-storage-failure']);
      expect((await fixture.client.reconnectState([chatId])).processing).toEqual({ outcome: 'snapshot', chats: [] });
      expect(fixture.fakeProviders.openAi.requests().map(request => request.lastUserText)).toEqual([
        'first-before-storage-failure', 'queued-before-storage-failure',
      ]);
    });
  });

  test.each(['provider-row', 'run-ended'])('releases execution after a %s write fails during a turn', async (rowKind) => {
    await withIntegrationFixture(`active-turn-write-failure-${rowKind}`, async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'input-before-write-failure' });
      const accepted = await fixture.client.startDirectChat({
        chatId,
        content: 'input-before-write-failure',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const ledgerPath = join(fixture.dirs.workspace, 'transcript-ledgers', chatId, 'ledger.sqlite');
      const db = new Database(ledgerPath);
      db.exec(`
        CREATE TRIGGER inject_active_turn_write_failure
        BEFORE INSERT ON transcript_rows
        WHEN NEW.kind = '${rowKind}'
        BEGIN
          SELECT RAISE(FAIL, 'injected active turn write failure');
        END
      `);
      db.close();

      const cursor = fixture.client.markEvents();
      held.releaseEcho();
      const terminal = await fixture.client.waitForTurnTerminal(chatId, accepted.turnId, {
        afterIndex: cursor,
        timeoutMs: 3000,
      });
      expect(terminal).toMatchObject({ type: 'agent-run-failed', chatId, turnId: accepted.turnId });
      expect((terminal as AgentRunFailedMessage).error).toContain('Transcript storage');
      expect((await fixture.client.reconnectState([chatId])).processing).toEqual({ outcome: 'snapshot', chats: [] });
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['input-before-write-failure']);

      const inspect = new Database(ledgerPath);
      expect(inspect.query("SELECT COUNT(*) AS count FROM transcript_rows WHERE kind = 'run-ended'").get()).toEqual({ count: 0 });
      inspect.exec('DROP TRIGGER inject_active_turn_write_failure');
      inspect.close();

      const retryError = await rejectionOf(fixture.client.runDirectChat({
        chatId,
        content: 'rejected-after-active-write-failure',
        agent: fixture.directAgents.openAi,
      }));
      expect(String(retryError)).not.toContain('Another chat turn already owns execution');
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);

      const healthyChat = fixture.newChatId();
      const healthy = await fixture.client.startDirectChat({
        chatId: healthyChat,
        content: 'healthy-after-other-chat-write-failure',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      expect((await fixture.client.waitForTurnTerminal(healthyChat, healthy.turnId)).type).toBe('agent-run-finished');
    });
  });

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

      expect(await throwingRejectionOf(fixture.client.runDirectChat({
        chatId,
        content: 'rejected-during-write-failure',
        agent: fixture.directAgents.openAi,
      }))).toThrow();
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        'durable-before-write-failure',
      ]);

      const cleanup = new Database(ledgerPath);
      cleanup.exec('DROP TRIGGER inject_transcript_write_failure');
      cleanup.close();

      expect(await throwingRejectionOf(fixture.client.runDirectChat({
        chatId,
        content: 'rejected-after-write-fence',
        agent: fixture.directAgents.openAi,
      }))).toThrow();
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
        'durable-before-write-failure',
      ]);
    });
  });
});
