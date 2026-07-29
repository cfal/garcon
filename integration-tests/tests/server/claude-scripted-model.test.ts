import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { messagesOfType } from '../../support/chat-assertions.js';
import {
  claudeText,
  claudeToolUse,
} from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import {
  startScriptedClaudeTestEnvironment,
  type ScriptedClaudeTestEnvironment,
} from '../../support/scripted-claude.js';

// The real pinned Claude CLI runs the whole turn -- spawn, local tool execution, JSONL
// transcript persistence -- while the model behind it is a deterministic script.
describe('Claude against a scripted model', () => {
  let environment: ScriptedClaudeTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedClaudeTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('completes a scripted tool turn end to end', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const marker = `GARCON_SCRIPTED_CLAUDE_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_DONE_${crypto.randomUUID().replaceAll('-', '')}`;
    testEnvironment.model.scriptTurn([
      claudeToolUse('toolu_scripted_1', 'Bash', { command: `echo ${marker}` }),
    ]);
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-model', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Run the scripted command.',
        permissionMode: 'bypassPermissions',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const transcript = await fixture.client.getMessages(chatId);
      const bash = messagesOfType(transcript.messages, 'bash-tool-use').find(
        (message) => message.command.includes(`echo ${marker}`),
      );
      if (!bash) throw new Error('Scripted Claude shell tool use was not rendered.');
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(marker);

      const requests = testEnvironment.model.requests();
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests[0].lastUserText).toContain('Run the scripted command.');
      const followUp = requests.find((request) =>
        request.toolResults.some((toolResult) =>
          toolResult.toolUseId === 'toolu_scripted_1' && toolResult.content.includes(marker)));
      if (!followUp) throw new Error('Tool result never reached the scripted model.');
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('holds a model request while the chat remains processing', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const reply = `SCRIPTED_HELD_${crypto.randomUUID().replaceAll('-', '')}`;
    const held = testEnvironment.model.scriptHeldTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-held-model', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveClaudeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Wait for the held scripted response.',
        permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      expect((await fixture.client.ping()).processing).toEqual({
        outcome: 'snapshot',
        chats: [{ chatId, phase: 'running' }],
      });

      held.release();
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: turn.turnId,
        marker: reply,
        afterIndex: cursor,
      });
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  test('retries a transient HTTP error', async () => {
    if (!environment) throw new Error('Scripted Claude environment was not initialized.');
    const testEnvironment = environment;
    const reply = `SCRIPTED_FAULT_RECOVERY_${crypto.randomUUID().replaceAll('-', '')}`;
    const prompt = 'Recover from the http-error response.';
    const requestStart = testEnvironment.model.requests().length;
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 500,
      message: 'transient scripted HTTP failure',
    });
    testEnvironment.model.scriptTurn([claudeText(reply)]);

    await withIntegrationFixture('claude-scripted-http-error', async (fixture) => {
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

      const requests = testEnvironment.model.requests().slice(requestStart);
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.lastUserText.includes(prompt))).toBe(true);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
    });
  });

  for (const fault of [
    { kind: 'stream-error' as const, message: 'scripted SSE failure' },
    { kind: 'truncated-stream' as const },
  ]) {
    test(`fails the turn after a ${fault.kind} despite a successful retry response`, async () => {
      if (!environment) throw new Error('Scripted Claude environment was not initialized.');
      const testEnvironment = environment;
      const prompt = `Fail on the ${fault.kind} response.`;
      const requestStart = testEnvironment.model.requests().length;
      testEnvironment.model.scriptFault(fault);
      testEnvironment.model.scriptTurn([
        claudeText(`SCRIPTED_UNUSED_RETRY_${crypto.randomUUID().replaceAll('-', '')}`),
      ]);

      await withIntegrationFixture(`claude-scripted-${fault.kind}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: prompt,
          permissionMode: 'bypassPermissions',
        }));
        expect((await fixture.client.waitForTurnTerminal(
          chatId,
          turn.turnId,
          { afterIndex: cursor, timeoutMs: 30_000 },
        )).type).toBe('agent-run-failed');

        const requests = testEnvironment.model.requests().slice(requestStart);
        expect(requests).toHaveLength(2);
        expect(requests.every((request) => request.lastUserText.includes(prompt))).toBe(true);
        testEnvironment.model.assertSettled();
      }, {
        serverEnvironment: testEnvironment.serverEnvironment,
      });
    });
  }
});
