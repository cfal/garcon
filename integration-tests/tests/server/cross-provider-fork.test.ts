import { describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('cross-provider fork lifecycle', () => {
  test('forks durable carry-over before the target provider materializes', async () => {
    await withIntegrationFixture('cross-provider-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId: sourceChatId,
        content: 'openai-source-turn',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, first.turnId);

      const anthropic = fixture.directAgents.anthropic;
      await fixture.client.switchAgentModel({
        chatId: sourceChatId,
        agentId: anthropic.agentId,
        model: anthropic.provider.model,
        apiProviderId: anthropic.provider.providerId,
        modelEndpointId: anthropic.provider.endpointId,
        modelProtocol: anthropic.provider.protocol,
      });
      const targetChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId, chatId: targetChatId });
      const reforkedChatId = fixture.newChatId();
      await fixture.client.forkChat({ sourceChatId: targetChatId, chatId: reforkedChatId });

      await fixture.restartGarcon();
      const targetTurn = await fixture.client.runDirectChat({
        chatId: reforkedChatId,
        content: 'anthropic-target-turn',
        agent: anthropic,
      });
      await fixture.client.waitForTurnTerminal(reforkedChatId, targetTurn.turnId);
      const targetRequest = fixture.fakeProviders.anthropic.requests()[0];
      expect(targetRequest.body.messages).toEqual([
        { role: 'user', content: targetRequest.lastUserText },
      ]);
      expect(targetRequest.lastUserText).toContain('anthropic-target-turn');
      expect(occurrences(targetRequest.lastUserText, '<carried-context>')).toBe(1);
      expect(occurrences(targetRequest.lastUserText, 'openai-source-turn')).toBe(2);

      const sourceTurn = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'anthropic-source-turn',
        agent: anthropic,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, sourceTurn.turnId);
      const sourceRequest = fixture.fakeProviders.anthropic.requests()[1];
      expect(sourceRequest.lastUserText).toContain('anthropic-source-turn');
      expect(sourceRequest.lastUserText).not.toContain('anthropic-target-turn');
      expect(occurrences(sourceRequest.lastUserText, 'openai-source-turn')).toBe(2);

      const target = await fixture.client.getMessages(reforkedChatId);
      expect(userContents(target.messages)).toEqual([
        'openai-source-turn',
        'anthropic-target-turn',
      ]);
      expect(assistantContents(target.messages)).toEqual([
        'echo:openai-source-turn',
        expect.stringContaining('anthropic-target-turn'),
      ]);
    });
  });
});

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
