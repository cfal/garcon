import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
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

  test(`controller restart drops ephemeral work without synthesizing history (${backend})`, async () => {
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
      const aborted = held.expectAbort();
      await fixture.crashAndRestartGarcon({ preserveExecutionWorker: true });
      await aborted;
      const after = await fixture.client.getMessages(chatId);
      expect(after).toMatchObject({ transcriptViewId: before.transcriptViewId, messages: before.messages });
      expect((await fixture.client.reconnectState([])).processing).toEqual({ outcome: 'snapshot', chats: [] });
      expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      const followup = await fixture.client.runDirectChat({ chatId, content: 'explicit-after-restart', agent: fixture.directAgents.openAi });
      expect(await fixture.client.waitForTurnTerminal(chatId, followup.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount + 1);
    }, { executionBackend: backend });
  }, 30_000);
}
