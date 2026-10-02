import { expect, test } from 'bun:test';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { rejectionOf } from '../../support/promise-assertions.js';

test('a repeated fork request ID returns the fork it created instead of a second chat', async () => {
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
    const request = { sourceChatId, chatId, clientRequestId: crypto.randomUUID() };
    const first = await fixture.client.forkChat(request);
    const repeated = await fixture.client.forkChat(request);

    expect(repeated.chat.id).toBe(chatId);
    expect(repeated.chat.parentChat).toEqual(first.chat.parentChat);
    // Without a request identity the target is simply taken.
    expect(await rejectionOf(fixture.client.forkChat({ sourceChatId, chatId }))).toMatchObject({
      status: 409, body: { errorCode: 'IDEMPOTENCY_CONFLICT' },
    });
    const forks = (await fixture.client.listChats()).sessions
      .filter((chat) => chat.parentChat?.chatId === sourceChatId);
    expect(forks.map((chat) => chat.id)).toEqual([chatId]);
  });
});
