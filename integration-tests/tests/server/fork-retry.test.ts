import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('a repeated fork request returns the fork it created instead of a second chat', async () => {
  await withIntegrationFixture('fork-retry', async (fixture) => {
    const sourceChatId = fixture.newChatId();
    const started = await fixture.client.startDirectChat({
      chatId: sourceChatId,
      content: 'Synthetic fork source',
      projectPath: fixture.dirs.project,
      agent: fixture.directAgents.openAi,
    });
    await fixture.client.waitForTurnTerminal(sourceChatId, started.turnId);

    const chatId = fixture.newChatId();
    const first = await fixture.client.forkChat({ sourceChatId, chatId });
    const repeated = await fixture.client.forkChat({ sourceChatId, chatId });

    expect(repeated.chat.id).toBe(chatId);
    expect(repeated.chat.parentChat).toEqual(first.chat.parentChat);
    const forks = (await fixture.client.listChats()).sessions
      .filter((chat) => chat.parentChat?.chatId === sourceChatId);
    expect(forks.map((chat) => chat.id)).toEqual([chatId]);
  });
});
