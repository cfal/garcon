import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { userContents, assistantContents } from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('instance-bound history imports through server reload', () => {
  for (const mode of ['partition-mutate', 'partition-truncate'] as const) {
    test(`${mode} cannot change a received provider batch during Reload cutover`, async () => {
      await withIntegrationFixture(`provider-history-${mode}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startDirectChat({ chatId, agent: fixture.directAgents.openAi,
          projectPath: fixture.dirs.project, content: 'Synthetic original input' });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const before = await fixture.client.getMessages(chatId);
        await fixture.client.reloadChat(chatId);
        const imported = await fixture.client.getMessages(chatId);
        expect(imported.transcriptViewId).not.toBe(before.transcriptViewId);
        expect(assistantContents(imported.messages).at(-1)).toBe('Synthetic imported row 257');
        let page = imported;
        const content = [...assistantContents(page.messages)];
        while (page.nextBeforeOrdinal !== null) {
          page = await fixture.client.getMessages(chatId, {
            beforeOrdinal: page.nextBeforeOrdinal, transcriptViewId: imported.transcriptViewId,
          });
          content.unshift(...assistantContents(page.messages));
        }
        expect(content).toEqual(Array.from({ length: 257 }, (_, index) => `Synthetic imported row ${index + 1}`));
        await fixture.restartGarcon();
        expect(await fixture.client.getMessages(chatId)).toEqual(imported);
      }, {
        bindAddress: '0.0.0.0', authentication: 'account',
        preloadModules: [fileURLToPath(new URL('../../support/provider-history-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_HISTORY_IMPORT: mode },
      });
    }, 30_000);
  }

  for (const mode of ['mutate', 'cancel-empty', 'cancel-rows', 'fail-cleanup'] as const) {
    test(`${mode} preserves controller-owned history and subsequent execution`, async () => {
      await withIntegrationFixture(`provider-history-${mode}`, async (fixture) => {
        const agent = fixture.directAgents.openAi;
        const chatId = fixture.newChatId();
        const started = await fixture.client.startDirectChat({
          chatId, agent, projectPath: fixture.dirs.project, content: 'Synthetic original input',
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        const before = await fixture.client.getMessages(chatId);
        if (mode === 'mutate') {
          await fixture.client.reloadChat(chatId);
          const imported = await fixture.client.getMessages(chatId);
          expect(imported.transcriptViewId).not.toBe(before.transcriptViewId);
          expect(userContents(imported.messages)).toEqual(userContents(before.messages));
          expect(assistantContents(imported.messages)).toEqual(assistantContents(before.messages));
        } else {
          await expect(fixture.client.reloadChat(chatId)).rejects.toMatchObject({
            response: { requestType: 'chat-reload', code: 'HISTORY_LOAD_FAILED',
              message: mode === 'fail-cleanup'
                ? 'Synthetic original import failure'
                : 'Synthetic native import cancellation at EOF' },
          });
          expect(await fixture.client.getMessages(chatId)).toEqual(before);
        }
        const resumed = await fixture.client.runDirectChat({ chatId, agent, content: 'Synthetic subsequent input' });
        await fixture.client.waitForTurnTerminal(chatId, resumed.turnId);
        const after = await fixture.client.getMessages(chatId);
        expect(userContents(after.messages)).toEqual(['Synthetic original input', 'Synthetic subsequent input']);
        expect(JSON.stringify(after)).not.toContain('Synthetic provider mutation after yield');
        await fixture.restartGarcon();
        expect(await fixture.client.getMessages(chatId)).toEqual(after);
      }, {
        bindAddress: '0.0.0.0', authentication: 'account',
        preloadModules: [fileURLToPath(new URL('../../support/provider-history-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_HISTORY_IMPORT: mode },
      });
    }, 30_000);
  }
});
