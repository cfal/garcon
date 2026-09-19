import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { messagesOfType, userContents } from '../../support/chat-assertions.js';
import { waitForPersistedChat } from '../../support/persisted-chat.js';

for (const backend of ['remote-controller-dials', 'remote-node-dials'] as const) {
  test(`same-agent handoff starts fresh on the destination and can leave an offline source (${backend})`, async () => {
    await withIntegrationFixture(`cross-node-handoff-${backend}`, async (fixture) => {
      const client = fixture.client;
      const agent = fixture.directAgents.openAi;
      const chatId = fixture.newChatId();
      const nativeId = () => waitForPersistedChat({
        directories: fixture.dirs, chatId, select: (chat) => chat.agentSessionId,
        timeoutMessage: 'Native session identity did not persist',
      });
      const local = await client.startDirectChat({ nodeId: 'local', chatId, content: 'Synthetic local input', projectPath: fixture.dirs.project, agent });
      await client.waitForTurnTerminal(chatId, local.turnId);
      const localSession = await nativeId();
      const original = await client.getMessages(chatId);
      const remote = await client.handoffDirectChat({
        chatId, agent, content: 'Synthetic remote input', nodeId: client.nodeId, projectPath: fixture.executionDirs.project,
      });
      await client.waitForTurnTerminal(chatId, remote.turnId);
      expect((await client.listChats()).sessions.find((chat) => chat.id === chatId)).toMatchObject({ nodeId: client.nodeId, projectPath: fixture.executionDirs.project });
      expect(await nativeId()).not.toBe(localSession);
      expect((await client.getMessages(chatId)).transcriptViewId).toBe(original.transcriptViewId);
      await client.waitForProcessing(chatId, false);
      await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { enabled: false });
      const returned = await client.handoffDirectChat({ chatId, agent, content: 'Synthetic return input', nodeId: 'local', projectPath: fixture.dirs.project });
      await client.waitForTurnTerminal(chatId, returned.turnId);
      const row = (await client.listChats()).sessions.find((chat) => chat.id === chatId)!;
      expect(row.nodeId ?? 'local').toBe('local');
      expect(row.projectPath).toBe(fixture.dirs.project);
      expect(await nativeId()).not.toBe(localSession);
      const messages = (await client.getMessages(chatId)).messages;
      expect(userContents(messages)).toEqual(['Synthetic local input', 'Synthetic remote input', 'Synthetic return input']);
      expect(messagesOfType(messages, 'agent-switch').map((message) => [message.fromNodeId, message.toNodeId])).toEqual([
        ['local', client.nodeId], [client.nodeId, 'local'],
      ]);
      await client.reloadChat(chatId);
      expect(messagesOfType((await client.getMessages(chatId)).messages, 'agent-switch')).toHaveLength(2);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(3);
    }, { executionBackend: backend, projectRoots: 'separate' });
  }, 45_000);
}
