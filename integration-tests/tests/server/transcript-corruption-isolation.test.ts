import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userContents } from '../../support/chat-assertions.js';
import { UnavailableChatHistoryError } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('transcript corruption isolation', () => {
  test('[TLV5-L11.01-SERVER-01] fences only the chat whose SQLite ledger is corrupt', async () => {
    await withIntegrationFixture('transcript-corruption-isolation', async (fixture) => {
      const corruptChatId = fixture.newChatId();
      const healthyChatId = fixture.newChatId();
      for (const [chatId, content] of [
        [corruptChatId, 'corrupt-ledger-chat'],
        [healthyChatId, 'healthy-ledger-chat'],
      ] as const) {
        const turn = await fixture.client.startDirectChat({
          chatId,
          content,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(chatId, turn.turnId);
      }
      const searchSettings = await fixture.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      expect(searchSettings.settings.features.transcriptSearch.enabled).toBe(true);
      await fixture.client.waitForChatSearch(
        { query: 'healthy-ledger-chat', chatIds: [corruptChatId, healthyChatId] },
        (response) => response.index.pendingChatCount === 0
          && response.index.indexedChatCount === 2,
      );

      await fixture.restartGarcon({
        beforeStart: () => writeFile(
          join(
            fixture.dirs.workspace,
            'transcript-ledgers',
            corruptChatId,
            'ledger.sqlite',
          ),
          'not a sqlite database',
        ),
      });

      let corruptHistory: unknown;
      try {
        await fixture.client.getMessages(corruptChatId);
      } catch (error) {
        corruptHistory = error;
      }
      expect(corruptHistory).toBeInstanceOf(UnavailableChatHistoryError);
      expect(corruptHistory).toMatchObject({
        chatId: corruptChatId,
        historyState: {
          kind: 'degraded',
          errorCode: 'LEDGER_FENCED',
          retryable: false,
        },
      });

      expect(userContents((await fixture.client.getMessages(healthyChatId)).messages)).toEqual([
        'healthy-ledger-chat',
      ]);
      const search = await fixture.client.waitForChatSearch(
        { query: 'healthy-ledger-chat', chatIds: [corruptChatId, healthyChatId] },
        (response) => response.index.pendingChatCount === 0
          && response.index.failedChatCount === 1,
      );
      expect(search.results.map((result) => result.chatId)).toEqual([healthyChatId]);
      expect(search.index).toEqual({
        indexedChatCount: 1,
        pendingChatCount: 0,
        failedChatCount: 1,
        unsupportedChatCount: 0,
      });
      const healthyTurn = await fixture.client.runDirectChat({
        chatId: healthyChatId,
        content: 'healthy-after-corruption',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(healthyChatId, healthyTurn.turnId);
      expect(userContents((await fixture.client.getMessages(healthyChatId)).messages)).toEqual([
        'healthy-ledger-chat',
        'healthy-after-corruption',
      ]);
    });
  });
});
