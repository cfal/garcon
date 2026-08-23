import { describe, expect, test } from 'bun:test';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('Direct native history persistence', () => {
  test('restores provider-owned history and model context after restart', async () => {
    await withIntegrationFixture('direct-native-history', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'native-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'native-b',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, second.turnId);
      const before = await fixture.client.getMessages(chatId);

      await fixture.restartGarcon();

      const restored = await fixture.client.getMessages(chatId);
      expect(userContents(restored.messages)).toEqual(userContents(before.messages));
      expect(assistantContents(restored.messages)).toEqual(assistantContents(before.messages));
      expect(restored.messages.map((entry) => entry.ordinal)).toEqual(
        before.messages.map((entry) => entry.ordinal),
      );
      expect(restored.transcriptViewId).toBe(before.transcriptViewId);

      const followUp = await fixture.client.runDirectChat({
        chatId,
        content: 'native-c',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, followUp.turnId);
      expect(
        fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => message.content),
      ).toEqual([
        'native-a',
        'echo:native-a',
        'native-b',
        'echo:native-b',
        'native-c',
      ]);
    });
  });
});
