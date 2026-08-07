import { describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('cross-provider fork lifecycle', () => {
  test('shares linked handoff history across repeated whole-chat forks', async () => {
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
      const handoff = await fixture.client.handoffDirectChat({
        chatId: sourceChatId,
        content: 'anthropic-handoff-turn',
        agent: anthropic,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, handoff.turnId);
      const handoffRequest = fixture.fakeProviders.anthropic.requests()[0];
      expect(handoffRequest.lastUserText).toContain('anthropic-handoff-turn');
      expect(occurrences(handoffRequest.lastUserText, '<carried-context version="1"')).toBe(1);

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

      const sourceTurn = await fixture.client.runDirectChat({
        chatId: sourceChatId,
        content: 'anthropic-source-turn',
        agent: anthropic,
      });
      await fixture.client.waitForTurnTerminal(sourceChatId, sourceTurn.turnId);
      const sourceRequest = fixture.fakeProviders.anthropic.requests().at(-1)!;
      expect(sourceRequest.lastUserText).toContain('anthropic-source-turn');
      expect(sourceRequest.lastUserText).not.toContain('anthropic-target-turn');

      const target = await fixture.client.getMessages(reforkedChatId);
      expect(userContents(target.messages)).toEqual([
        'openai-source-turn',
        'anthropic-handoff-turn',
        'anthropic-target-turn',
      ]);
      expect(assistantContents(target.messages)).toEqual([
        'echo:openai-source-turn',
        expect.stringContaining('anthropic-handoff-turn'),
        expect.stringContaining('anthropic-target-turn'),
      ]);
    });
  });
});

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
