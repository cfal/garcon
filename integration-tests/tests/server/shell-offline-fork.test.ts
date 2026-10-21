import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`retained Shell history forks without its executor (${executionBackend})`, async () => {
    await withIntegrationFixture(`shell-offline-fork-${executionBackend}`, async fixture => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startChat({ chatId, agentId: 'shell', model: 'notes',
        projectPath: fixture.executionDirs.project, permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} }, origin: 'interactive',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command: 'Synthetic retained note' });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      await fixture.client.waitForProcessing(chatId, false);
      await fixture.client.patch(`/api/v1/executors/${fixture.client.executorId}`, { enabled: false });
      const forkId = fixture.newChatId();
      const fork = await fixture.client.forkChat({ sourceChatId: chatId, chatId: forkId, clientRequestId: crypto.randomUUID() });
      expect(fork.chat).toMatchObject({ id: forkId, executorId: fixture.client.executorId, model: 'notes' });
      expect((await fixture.client.getMessages(forkId)).messages.map(row => row.message)
        .filter(message => message.type === 'user-message').map(message => message.content)).toEqual(['Synthetic retained note']);

      const executingForkId = fixture.newChatId();
      expect(await rejectionOf(fixture.client.forkRunChat({
        sourceChatId: chatId, chatId: executingForkId, command: 'Synthetic new note',
        clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      }))).toMatchObject({ status: 503, body: { errorCode: 'EXECUTOR_UNAVAILABLE' } });
      expect((await fixture.client.listChats()).sessions.map(chat => chat.id)).not.toContain(executingForkId);
    }, { executionBackend });
  }, 60_000);
}
