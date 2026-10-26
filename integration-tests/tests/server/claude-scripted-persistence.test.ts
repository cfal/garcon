import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '../../../common/json.js';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { forkAfterSourceSettles } from '../../support/fork-test-support.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  reloadUntilNativeContains,
  reloadUntilNativeStableAfterPrompt,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
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
    const toolOutput = `SCRIPTED_CLAUDE_PERSIST_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CLAUDE_PERSIST_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const prompt = `Run the scripted persistence command for ${toolOutput}.`;
    const command = `printf %s ${toolOutput}`;
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
        toolOutput,
        reply,
        prompt,
      );

      await fixture.restartGarcon();
      const restored = expectToolTurn(
        await fixture.client.getMessages(chatId),
        command,
        toolOutput,
        reply,
        prompt,
      );
      expect(restored).toEqual(live);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('preserves parallel tool branches through reload, fork, and resume', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = 'Read both synthetic parallel files.';
    const reply = 'SCRIPTED_PARALLEL_COMPLETE';
    const resumedPrompt = 'Resume the synthetic parallel history.';
    const resumedReply = 'SCRIPTED_PARALLEL_RESUMED';
    const tools = ['alpha', 'beta'].map((name) => ({
      id: `toolu_parallel_${name}`,
      output: `SCRIPTED_PARALLEL_${name.toUpperCase()}`,
      file: `parallel-${name}.txt`,
    }));

    await withIntegrationFixture('claude-parallel-history', async (fixture) => {
      for (const tool of tools) {
        await writeFile(join(fixture.dirs.project, tool.file), tool.output, 'utf8');
      }
      testEnvironment.model.scriptTurn(tools.map((tool) => claudeToolUse(tool.id, 'Read', {
        file_path: join(fixture.dirs.project, tool.file),
      })));
      testEnvironment.model.scriptTurn((request) => {
        for (const tool of tools) {
          expect(request.toolResults).toContainEqual(expect.objectContaining({
            toolUseId: tool.id,
            content: expect.stringContaining(tool.output),
          }));
        }
        return [claudeText(reply)];
      });
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: turn.turnId, marker: reply, afterIndex: cursor,
      });

      const expectParallelTurn = (transcript: Awaited<ReturnType<GarconTestClient['getMessages']>>) => {
        const calls = messagesOfType(transcript.messages, 'read-tool-use');
        const results = messagesOfType(transcript.messages, 'tool-result');
        expect(calls).toHaveLength(tools.length);
        expect(results).toHaveLength(tools.length);
        expect(countUserContent(transcript.messages, prompt)).toBe(1);
        expect(assistantContents(transcript.messages)).toContain(reply);
        return tools.map((tool) => {
          expect(calls).toContainEqual(expect.objectContaining({
            toolId: tool.id, filePath: join(fixture.dirs.project, tool.file),
          }));
          const result = results.find((candidate) => candidate.toolId === tool.id);
          expect(result?.isError).toBe(false);
          expect(JSON.stringify(result?.content)).toContain(tool.output);
          return result?.content;
        });
      };
      const live = expectParallelTurn(await fixture.client.getMessages(chatId));
      await reloadUntilNativeContains(fixture, chatId, reply);
      expect(expectParallelTurn(await fixture.client.getMessages(chatId))).toEqual(live);

      const binding = await waitForPersistedNativeSession({
        directories: fixture.dirs, chatId, agentId: 'claude',
      });
      const nativePath = binding.nativeSession?.value.path;
      if (typeof nativePath !== 'string') throw new Error('Claude native path was not persisted.');
      const parents = (await readFile(nativePath, 'utf8')).split('\n')
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line))
        .filter(isRecord)
        .filter((entry) => entry.type === 'assistant' || entry.type === 'user')
        .map((entry) => entry.parentUuid)
        .filter((parent): parent is string => typeof parent === 'string');
      // A single parent-chain walk would lose a branch of this real CLI transcript.
      // https://github.com/anthropics/claude-agent-sdk-python/blob/0e89b298e771259378a6cd3734e00d323dff5703/src/claude_agent_sdk/_internal/sessions.py#L1095-L1115
      expect(new Set(parents).size).toBeLessThan(parents.length);

      const forkChatId = fixture.newChatId();
      await forkAfterSourceSettles(fixture, chatId, forkChatId);
      expect(expectParallelTurn(await fixture.client.getMessages(forkChatId))).toEqual(live);
      const forkBinding = await waitForPersistedNativeSession({
        directories: fixture.dirs, chatId: forkChatId, agentId: 'claude',
      });
      expect(forkBinding.agentSessionId).not.toBe(binding.agentSessionId);

      await fixture.restartGarcon();
      for (const targetChatId of [chatId, forkChatId]) {
        expect(expectParallelTurn(await fixture.client.getMessages(targetChatId))).toEqual(live);
        testEnvironment.model.scriptTurn((request) => {
          expect(request.lastUserText).toContain(resumedPrompt);
          for (const tool of tools) {
            expect(request.toolResults).toContainEqual(expect.objectContaining({
              toolUseId: tool.id,
              content: expect.stringContaining(tool.output),
            }));
          }
          return [claudeText(resumedReply)];
        });
        const resumedCursor = fixture.client.markEvents();
        const resumed = await fixture.client.runChat(liveClaudeRunRequest({
          chatId: targetChatId, command: resumedPrompt, permissionMode: 'bypassPermissions',
        }));
        await waitForVisibleResponse({
          fixture, chatId: targetChatId, turnId: resumed.turnId,
          marker: resumedReply, afterIndex: resumedCursor,
        });
      }
      testEnvironment.model.assertSettled();
    }, { serverEnvironment: testEnvironment.serverEnvironment });
  }, 60_000);

  test('keeps provider-origin native rows out of an explicit reload', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const prompt = 'SCRIPTED_CLAUDE_ORIGIN_FILTER_PROMPT';
    const reply = 'SCRIPTED_CLAUDE_ORIGIN_FILTER_REPLY';
    const providerText = 'SCRIPTED_CLAUDE_ORIGIN_FILTER_PROVIDER_ROW';
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-origin-reload-filter', async (fixture) => {
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
      await reloadUntilNativeStableAfterPrompt(fixture, chatId, prompt);

      const binding = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId,
        agentId: 'claude',
      });
      const nativePath = binding.nativeSession?.value.path;
      if (typeof nativePath !== 'string') throw new Error('Claude native path was not persisted.');
      const providerEntry = {
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd: fixture.dirs.project,
        sessionId: binding.agentSessionId,
        version: '2.1.280',
        type: 'user',
        message: { role: 'user', content: providerText },
        uuid: '00000000-0000-4000-8000-000000000280',
        timestamp: '2099-01-01T00:00:00.000Z',
        origin: { kind: 'peer', from: 'synthetic-peer' },
      };
      await appendFile(
        nativePath,
        `${JSON.stringify(providerEntry)}\n`,
        'utf8',
      );

      await fixture.client.reloadChat(chatId);
      const reloaded = await fixture.client.getMessages(chatId);
      expect(userContents(reloaded.messages)).toEqual([prompt]);
      expect(assistantContents(reloaded.messages)).toContain(reply);
      expect(JSON.stringify(reloaded.messages)).not.toContain(providerText);
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

  test('resumes a forked native session after server restart', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sourcePrompt = marker('FORK_RESTART_SOURCE_PROMPT');
    const sourceReply = marker('FORK_RESTART_SOURCE_REPLY');
    const resumedPrompt = marker('FORK_RESTART_RESUMED_PROMPT');
    const resumedReply = marker('FORK_RESTART_RESUMED_REPLY');
    testEnvironment.model.scriptTurn([claudeText(sourceReply)]);

    await withIntegrationFixture('claude-fork-restart-resume', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(liveClaudeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: sourcePrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: source.turnId,
        marker: sourceReply,
        afterIndex: sourceCursor,
      });

      const forkChatId = fixture.newChatId();
      await forkAfterSourceSettles(fixture, sourceChatId, forkChatId);
      const nativeBeforeRestart = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'claude',
      });

      await fixture.restartGarcon();
      testEnvironment.model.scriptTurn((request) => {
        expect(request.lastUserText).toContain(resumedPrompt);
        expect(JSON.stringify(request.body.messages)).toContain(sourcePrompt);
        expect(JSON.stringify(request.body.messages)).toContain(sourceReply);
        return [claudeText(resumedReply)];
      });
      const resumedCursor = fixture.client.markEvents();
      const resumed = await fixture.client.runChat(liveClaudeRunRequest({
        chatId: forkChatId,
        command: resumedPrompt,
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: forkChatId,
        turnId: resumed.turnId,
        marker: resumedReply,
        afterIndex: resumedCursor,
      });

      const transcript = await fixture.client.getMessages(forkChatId);
      expect(userContents(transcript.messages)).toEqual([sourcePrompt, resumedPrompt]);
      expect(assistantContents(transcript.messages)).toEqual(expect.arrayContaining([
        sourceReply,
        resumedReply,
      ]));
      const nativeAfterResume = await waitForPersistedNativeSession({
        directories: fixture.dirs,
        chatId: forkChatId,
        agentId: 'claude',
      });
      expect(nativeAfterResume.agentSessionId).toBe(nativeBeforeRestart.agentSessionId);
      expect(nativeAfterResume.nativeSession).toEqual(nativeBeforeRestart.nativeSession);
      expect(userContents((await fixture.client.getMessages(sourceChatId)).messages)).toEqual([
        sourcePrompt,
      ]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);

  test('correlates a queued answer within each replacement transcript view', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const sourcePrompt = marker('RELOAD_CORRELATION_SOURCE_PROMPT');
    const sourceReply = marker('RELOAD_CORRELATION_SOURCE_REPLY');
    const queuedPrompt = marker('RELOAD_CORRELATION_QUEUED_PROMPT');
    const queuedReply = marker('RELOAD_CORRELATION_QUEUED_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([claudeText(sourceReply)]);
    testEnvironment.model.scriptTurn([claudeText(queuedReply)]);

    await withIntegrationFixture('claude-reload-view-correlation', async (fixture) => {
      const chatId = fixture.newChatId();
      const sourceCursor = fixture.client.markEvents();
      const source = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: sourcePrompt,
        permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      const queueCursor = fixture.client.markEvents();
      await fixture.client.enqueueNew(chatId, queuedPrompt);
      held.release();

      expect((await fixture.client.waitForTurnTerminal(chatId, source.turnId, {
        afterIndex: sourceCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');
      const queuedInput = await fixture.client.waitForCommittedUserInput(
        chatId,
        queuedPrompt,
        { afterIndex: queueCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expect((await fixture.client.waitForTurnTerminal(chatId, undefined, {
        afterIndex: fixture.client.events().lastIndexOf(queuedInput) + 1,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      })).type).toBe('agent-run-finished');

      const live = await fixture.client.getMessages(chatId);
      const liveQueuedPrompt = live.messages.find((entry) =>
        entry.message.type === 'user-message' && entry.message.content === queuedPrompt);
      if (!liveQueuedPrompt) throw new Error('Live queued prompt was not committed.');
      const reloaded = await reloadUntilNativeStableAfterPrompt(fixture, chatId, queuedPrompt);
      const reloadedQueuedPrompt = reloaded.messages.find((entry) =>
        entry.message.type === 'user-message' && entry.message.content === queuedPrompt);
      if (!reloadedQueuedPrompt) throw new Error('Reloaded queued prompt was not imported.');

      // Replacement views assign fresh ordinals, so ordinals cannot be ordered across views.
      expect(reloadedQueuedPrompt.ordinal).not.toBe(liveQueuedPrompt.ordinal);
      expect(userContents(reloaded.messages)).toEqual([sourcePrompt, queuedPrompt]);
      expect(assistantContents(reloaded.messages)).toEqual([sourceReply, queuedReply]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  }, 60_000);
});

function marker(label: string): string {
  return `SCRIPTED_CLAUDE_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function expectToolTurn(
  transcript: Awaited<ReturnType<GarconTestClient['getMessages']>>,
  command: string,
  expectedOutput: string,
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
  expect(JSON.stringify(result?.content)).toContain(expectedOutput);
  expect(assistantContents(transcript.messages).some((content) => content.includes(reply))).toBe(true);
  expect(countUserContent(transcript.messages, prompt)).toBe(1);
  if (!result) throw new Error('Claude shell tool result was not rendered.');
  return {
    command: bash.command,
    content: result.content,
    isError: result.isError,
  };
}
