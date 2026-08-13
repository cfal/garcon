import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
} from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

describe('scripted Claude persistence', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('restores a tool turn from native history after restart', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const marker = `SCRIPTED_CLAUDE_PERSIST_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CLAUDE_PERSIST_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const prompt = `Run the scripted persistence command for ${marker}.`;
    const command = `printf %s ${marker}`;
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_scripted_persist', 'Bash', { command }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-persistence', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      const live = expectToolTurn(
        await fixture.client.getMessages(chatId),
        command,
        marker,
        reply,
        prompt,
      );

      await fixture.restartGarcon();
      const restored = expectToolTurn(
        await fixture.client.getMessages(chatId),
        command,
        marker,
        reply,
        prompt,
      );
      expect(restored).toEqual(live);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('repairs stale registry session metadata from the ledger before resume', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const firstReply = `SCRIPTED_CLAUDE_CACHE_FIRST_${crypto.randomUUID().replaceAll('-', '')}`;
    const secondReply = `SCRIPTED_CLAUDE_CACHE_SECOND_${crypto.randomUUID().replaceAll('-', '')}`;
    testEnvironment.model.scriptTurn([claudeText(firstReply)]);
    testEnvironment.model.scriptTurn([claudeText(secondReply)]);

    await withIntegrationFixture('claude-session-cache-repair', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Establish the scripted native session.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      const authoritative = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: 'claude',
      });

      await fixture.restartGarcon({
        beforeStart: async () => {
          const registryPath = join(fixture.dirs.workspace, 'chats.json');
          const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
            sessions: Record<string, Record<string, unknown>>;
          };
          const chat = registry.sessions[chatId];
          if (!chat) throw new Error(`Claude chat ${chatId} was not persisted.`);
          chat.agentSessionId = null;
          chat.nativeSession = null;
          chat.nativeSeedReceipt = null;
          await writeFile(registryPath, JSON.stringify(registry), 'utf8');
        },
      });

      expect(assistantContents((await fixture.client.getMessages(chatId)).messages)).toContain(
        firstReply,
      );
      const secondCursor = fixture.client.markEvents();
      const second = await fixture.client.runChat(liveClaudeRunRequest({
        chatId,
        command: 'Resume the repaired scripted native session.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: second.turnId,
        marker: secondReply,
        afterIndex: secondCursor,
      });
      const repaired = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: 'claude',
      });
      expect(repaired.agentSessionId).toBe(authoritative.agentSessionId);
      expect(repaired.nativeSession).toEqual(authoritative.nativeSession);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);
});

function expectToolTurn(
  transcript: Awaited<ReturnType<GarconTestClient['getMessages']>>,
  command: string,
  marker: string,
  reply: string,
  prompt: string,
): { readonly command: string; readonly content: Record<string, unknown>; readonly isError: boolean } {
  const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
    (message) => message.command === command,
  );
  if (!bash) throw new Error('Claude shell tool use was not rendered.');
  const result = messagesOfType(transcript.messages, 'tool-result').find(
    (message) => message.toolId === bash.toolId,
  );
  expect(result?.isError).toBe(false);
  expect(JSON.stringify(result?.content)).toContain(marker);
  expect(assistantContents(transcript.messages).some((content) => content.includes(reply))).toBe(true);
  expect(countUserContent(transcript.messages, prompt)).toBe(1);
  if (!result) throw new Error('Claude shell tool result was not rendered.');
  return {
    command: bash.command,
    content: result.content,
    isError: result.isError,
  };
}
