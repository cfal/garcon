import { describe, expect, test } from 'bun:test';
import {
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { ChatDetailsResponse } from '../../../common/chat-details.js';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import {
  type IntegrationFixture,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';

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

  test('fails a resumed turn without a provider request when native history is missing or corrupt', async () => {
    await withIntegrationFixture('direct-native-history-fail-closed', async (fixture) => {
      const missingChatId = fixture.newChatId();
      const corruptChatId = fixture.newChatId();
      for (const [chatId, content] of [
        [missingChatId, 'missing-native-source'],
        [corruptChatId, 'corrupt-native-source'],
      ] as const) {
        const started = await fixture.client.startDirectChat({
          chatId,
          content,
          projectPath: fixture.dirs.project,
          agent: fixture.directAgents.openAi,
        });
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      }

      const missingPath = await directSessionPath(fixture, missingChatId);
      const corruptPath = await directSessionPath(fixture, corruptChatId);
      const requestCount = fixture.fakeProviders.openAi.requests().length;
      await fixture.restartGarcon({
        beforeStart: async () => {
          await rm(missingPath);
          const raw = await readFile(corruptPath, 'utf8');
          const headerEnd = raw.indexOf('\n');
          if (headerEnd < 0) throw new Error('Direct session fixture has no complete header.');
          await writeFile(
            corruptPath,
            `${raw.slice(0, headerEnd + 1)}{malformed}\n${raw.slice(headerEnd + 1)}`,
          );
        },
      });

      for (const [chatId, content] of [
        [missingChatId, 'resume-missing-native-source'],
        [corruptChatId, 'resume-corrupt-native-source'],
      ] as const) {
        const accepted = await fixture.client.runDirectChat({
          chatId,
          content,
          agent: fixture.directAgents.openAi,
        });
        expect(await fixture.client.waitForTurnTerminal(chatId, accepted.turnId)).toMatchObject({
          type: 'agent-run-failed',
          error: 'This conversation cannot be loaded because its Direct history is unavailable.',
        });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requestCount);
      }
    });
  }, 30_000);

  test('deletes the current native file while retiring a running Direct turn', async () => {
    await withIntegrationFixture('direct-native-history-running-delete', async (fixture) => {
      const chatId = fixture.newChatId();
      const held = fixture.fakeProviders.openAi.holdNext({
        lastUserText: 'delete-running-native-source',
      });
      await fixture.client.startDirectChat({
        chatId,
        content: 'delete-running-native-source',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await held.received;
      const nativePath = await directSessionPath(fixture, chatId);
      const aborted = held.expectAbort();

      expect(await fixture.client.deleteChat(chatId)).toEqual({ success: true });
      await aborted;
      await expect(stat(nativePath)).rejects.toMatchObject({ code: 'ENOENT' });

      await fixture.restartGarcon();
      expect((await fixture.client.listChats()).sessions.map((chat) => chat.id))
        .not.toContain(chatId);
    });
  }, 30_000);

  test('retains an outgoing handoff file, strips the carried seed on Reload, and deletes the current file', async () => {
    await withIntegrationFixture('direct-native-history-handoff-delete', async (fixture) => {
      const chatId = fixture.newChatId();
      const source = await fixture.client.startDirectChat({
        chatId,
        content: 'handoff-native-source',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, source.turnId);
      const outgoingPath = await directSessionPath(fixture, chatId);

      const held = fixture.fakeProviders.anthropic.holdNext({
        model: fixture.directAgents.anthropic.provider.model,
      });
      const handoff = await fixture.client.handoffDirectChat({
        chatId,
        content: 'handoff-native-target',
        agent: fixture.directAgents.anthropic,
      });
      await held.received;
      expect(held.releaseText('handoff-native-target-answer')).toBeTrue();
      await fixture.client.waitForTurnTerminal(chatId, handoff.turnId);
      const currentPath = await directSessionPath(fixture, chatId);
      expect(currentPath).not.toBe(outgoingPath);
      expect((await stat(outgoingPath)).isFile()).toBeTrue();
      expect((await stat(currentPath)).isFile()).toBeTrue();

      const reloaded = await fixture.client.reloadChat(chatId);
      expect(userContents(reloaded.messages)).toEqual([
        'handoff-native-source',
        'handoff-native-target',
      ]);
      expect(assistantContents(reloaded.messages)).toEqual([
        'echo:handoff-native-source',
        'handoff-native-target-answer',
      ]);
      expect(JSON.stringify(reloaded.messages)).not.toContain('<carried-context');

      expect(await fixture.client.deleteChat(chatId)).toEqual({ success: true });
      expect((await stat(outgoingPath)).isFile()).toBeTrue();
      await expect(stat(currentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 30_000);
});

async function directSessionPath(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<string> {
  const query = new URLSearchParams({ chatId });
  const details = await fixture.client.get<ChatDetailsResponse>(
    `/api/v1/chats/details?${query}`,
  );
  if (details.transcriptSource?.kind !== 'filesystem-path') {
    throw new Error(`Chat ${chatId} has no Direct filesystem source.`);
  }
  return details.transcriptSource.value;
}
