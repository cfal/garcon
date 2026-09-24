import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { GarconWsRequestError } from '../../support/garcon-client.js';

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`worker loss settles other chats after one terminal write fails (${backend})`, async () => {
    await withIntegrationFixture(`worker-loss-ledger-fence-${backend}`, async (fixture) => {
      const failedChat = fixture.newChatId();
      const healthyChat = fixture.newChatId();
      const failedOutput = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic fenced job' });
      const healthyOutput = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic healthy job' });
      await fixture.client.startDirectChat({
        chatId: failedChat, content: 'Synthetic fenced job', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await failedOutput.received;
      const healthy = await fixture.client.startDirectChat({
        chatId: healthyChat, content: 'Synthetic healthy job', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await healthyOutput.received;
      const db = new Database(join(fixture.dirs.workspace, 'transcript-ledgers', failedChat, 'ledger.sqlite'));
      try {
        db.exec("CREATE TRIGGER inject_terminal_failure BEFORE INSERT ON transcript_rows BEGIN SELECT RAISE(FAIL, 'synthetic terminal failure'); END");
      } finally { db.close(); }
      const failedAbort = failedOutput.expectAbort();
      const healthyAbort = healthyOutput.expectAbort();
      await fixture.crashAndRestartExecutionWorker();
      await failedAbort;
      await healthyAbort;
      expect(await fixture.client.waitForTurnTerminal(healthyChat, healthy.turnId)).toMatchObject({ type: 'agent-run-failed' });
      await fixture.client.waitForProcessing(healthyChat, false);
      expect((await fixture.client.reconnectState([])).processing).toEqual({ outcome: 'snapshot', chats: [] });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
      const followup = await fixture.client.runDirectChat({ chatId: healthyChat, content: 'Synthetic followup', agent: fixture.directAgents.openAi });
      expect(await fixture.client.waitForTurnTerminal(healthyChat, followup.turnId)).toMatchObject({ type: 'agent-run-finished' });
    }, { executionBackend: backend });
  }, 30_000);

  test(`worker restart reports loss once, frees ownership and never retries (${backend})`, async () => {
    await withIntegrationFixture(`worker-restart-${backend}`, async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'interrupted-native-work' });
      const started = await fixture.client.startDirectChat({
        chatId, content: 'interrupted-native-work', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const before = await fixture.client.getMessages(chatId);
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      const aborted = held.expectAbort();
      await fixture.crashAndRestartExecutionWorker();
      await aborted;
      expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-failed' });
      await fixture.client.waitForProcessing(chatId, false);
      const after = await fixture.client.getMessages(chatId);
      expect(after.transcriptViewId).toBe(before.transcriptViewId);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      expect((await fixture.client.reconnectState([])).processing).toEqual({ outcome: 'snapshot', chats: [] });
      const terminals = fixture.client.eventRecords().filter(({ parsed }) => parsed.type === 'agent-run-failed' && parsed.chatId === chatId);
      expect(terminals).toHaveLength(1);
      const followup = await fixture.client.runDirectChat({ chatId, content: 'explicit-new-turn', agent: fixture.directAgents.openAi });
      expect(await fixture.client.waitForTurnTerminal(chatId, followup.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount + 1);
    }, { executionBackend: backend });
  }, 30_000);

  test(`controller restart keeps native work alive without replay or overlapping turns (${backend})`, async () => {
    await withIntegrationFixture(`controller-restart-${backend}`, async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'held-before-controller-crash' });
      await fixture.client.startDirectChat({
        chatId, content: 'held-before-controller-crash', projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
      });
      await held.received;
      await fixture.client.enqueueNew(chatId, 'discarded-queued-turn');
      const before = await fixture.client.getMessages(chatId);
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
      const after = await fixture.client.getMessages(chatId);
      expect(after).toMatchObject({ transcriptViewId: before.transcriptViewId, messages: before.messages });
      expect((await fixture.client.reconnectState([])).processing).toEqual({ outcome: 'snapshot', chats: [] });
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      const blocked = await fixture.client.runDirectChat({ chatId, content: 'rejected-while-detached', agent: fixture.directAgents.openAi });
      expect(await fixture.client.waitForTurnTerminal(chatId, blocked.turnId)).toMatchObject({
        type: 'agent-run-failed', error: expect.stringContaining('earlier turn is still running'),
      });
      await expect(fixture.client.reloadChat(chatId)).rejects.toMatchObject({ response: {
        code: 'HISTORY_LOAD_FAILED', message: expect.stringContaining('turn is still running'),
      } });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      expect(held.releaseText('Synthetic output while controller was disconnected')).toBe(true);
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          const reloaded = await fixture.client.reloadChat(chatId);
          expect(assistantContents(reloaded.messages)).toContain('Synthetic output while controller was disconnected');
          break;
        } catch (error) {
          if (!(error instanceof GarconWsRequestError) || error.response.code !== 'HISTORY_LOAD_FAILED'
            || !error.response.message.includes('turn is still running') || Date.now() >= deadline) throw error;
          await Bun.sleep(10);
        }
      }
      const followup = await fixture.client.runDirectChat({ chatId, content: 'explicit-after-restart', agent: fixture.directAgents.openAi });
      expect(await fixture.client.waitForTurnTerminal(chatId, followup.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount + 1);
    }, { executionBackend: backend });
  }, 30_000);
}
