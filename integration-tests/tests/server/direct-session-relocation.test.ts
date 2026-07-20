import { describe, expect, test } from 'bun:test';
import { access, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assistantContents,
  userContents,
} from '../../support/chat-assertions.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

describe('direct session relocation', () => {
  test('restores pre-split direct history into agent-scoped storage', async () => {
    await withIntegrationFixture('direct-session-relocation', async (fixture) => {
      const chatId = fixture.newChatId();
      const first = await fixture.client.startDirectChat({
        chatId,
        content: 'legacy-a',
        projectPath: fixture.dirs.project,
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, first.turnId);
      const second = await fixture.client.runDirectChat({
        chatId,
        content: 'legacy-b',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, second.turnId);
      const before = await fixture.client.getMessages(chatId);

      const registry = JSON.parse(
        await readFile(join(fixture.dirs.workspace, 'chats.json'), 'utf8'),
      ) as { sessions: Record<string, { agentSessionId: string }> };
      const sessionId = registry.sessions[chatId]?.agentSessionId;
      if (!sessionId) throw new Error(`Direct chat ${chatId} is missing its agent session ID`);

      const agentDirectory = join(
        fixture.dirs.workspace,
        'agent-data',
        'direct-openai-compatible',
      );
      const sessionsLabel = 'openai-compatible-sessions';
      const legacyDirectory = join(fixture.dirs.workspace, sessionsLabel);
      const scopedDirectory = join(agentDirectory, sessionsLabel);
      const sessionFile = join(
        scopedDirectory,
        fixture.directAgents.openAi.provider.endpointId,
        `${sessionId}.jsonl`,
      );
      await access(sessionFile);

      await fixture.restartGarcon({
        beforeStart: async () => {
          await rename(scopedDirectory, legacyDirectory);
          await rm(join(agentDirectory, 'migration-state.json'), { force: true });
        },
      });

      const restored = await fixture.client.getMessages(chatId);
      expect(userContents(restored.messages)).toEqual(userContents(before.messages));
      expect(assistantContents(restored.messages)).toEqual(assistantContents(before.messages));
      expect(restored.messages.map((entry) => entry.seq)).toEqual(
        before.messages.map((entry) => entry.seq),
      );
      await expect(access(legacyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await access(sessionFile);

      const followUp = await fixture.client.runDirectChat({
        chatId,
        content: 'legacy-c',
        agent: fixture.directAgents.openAi,
      });
      await fixture.client.waitForTurnTerminal(chatId, followUp.turnId);
      expect(
        fixture.fakeProviders.openAi.requests().at(-1)?.body.messages.map((message) => message.content),
      ).toEqual([
        'legacy-a',
        'echo:legacy-a',
        'legacy-b',
        'echo:legacy-b',
        'legacy-c',
      ]);
    });
  });
});
