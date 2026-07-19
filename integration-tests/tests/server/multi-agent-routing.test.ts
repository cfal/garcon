import { describe, expect, test } from 'bun:test';
import { assistantContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('multi-agent routing', () => {
  test('isolates concurrent providers and preserves their histories across restart', async () => {
    await withIntegrationFixture('multi-agent-routing', async (fixture) => {
      const openAiChatId = fixture.newChatId();
      const anthropicChatId = fixture.newChatId();
      const heldOpenAi = fixture.fakeProviders.openAi.holdNext({
        lastUserText: 'routing-openai-one',
      });
      const heldAnthropic = fixture.fakeProviders.anthropic.holdNext({
        lastUserText: 'routing-anthropic-one',
      });
      const cursor = fixture.client.markEvents();

      const openAiAccepted = await fixture.client.startDirectChat({
        chatId: openAiChatId,
        content: 'routing-openai-one',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      const anthropicAccepted = await fixture.client.startDirectChat({
        chatId: anthropicChatId,
        content: 'routing-anthropic-one',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.anthropic,
      });
      await Promise.all([heldOpenAi.received, heldAnthropic.received]);
      expect(heldAnthropic.releaseText('anthropic-routed')).toBe(true);
      await fixture.client.waitForTurnTerminal(anthropicChatId, anthropicAccepted.turnId, {
        afterIndex: cursor,
      });
      heldOpenAi.releaseText('openai-routed');
      await fixture.client.waitForTurnTerminal(openAiChatId, openAiAccepted.turnId, {
        afterIndex: cursor,
      });

      expect(assistantContents((await fixture.client.getMessages(openAiChatId)).messages)).toEqual([
        'openai-routed',
      ]);
      expect(assistantContents((await fixture.client.getMessages(anthropicChatId)).messages)).toEqual([
        'anthropic-routed',
      ]);
      expect(fixture.fakeProviders.openAi.requests().map((request) => request.lastUserText)).toEqual([
        'routing-openai-one',
      ]);
      expect(fixture.fakeProviders.anthropic.requests().map((request) => request.lastUserText)).toEqual([
        'routing-anthropic-one',
      ]);

      await fixture.restartGarcon();
      const openAiSecond = await fixture.client.runDirectChat({
        chatId: openAiChatId,
        content: 'routing-openai-two',
        agent: fixture.directAgents.openAi,
      });
      const anthropicSecond = await fixture.client.runDirectChat({
        chatId: anthropicChatId,
        content: 'routing-anthropic-two',
        agent: fixture.directAgents.anthropic,
      });
      await Promise.all([
        fixture.client.waitForTurnTerminal(openAiChatId, openAiSecond.turnId),
        fixture.client.waitForTurnTerminal(anthropicChatId, anthropicSecond.turnId),
      ]);

      expect(fixture.fakeProviders.openAi.requests()[1].body.messages).toEqual([
        { role: 'user', content: 'routing-openai-one' },
        { role: 'assistant', content: 'openai-routed' },
        { role: 'user', content: 'routing-openai-two' },
      ]);
      expect(fixture.fakeProviders.anthropic.requests()[1].body.messages).toEqual([
        { role: 'user', content: 'routing-anthropic-one' },
        { role: 'assistant', content: 'anthropic-routed' },
        { role: 'user', content: 'routing-anthropic-two' },
      ]);
    });
  });
});
