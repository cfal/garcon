import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { messagesOfType } from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
  type CodexScriptedFault,
} from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

// The real pinned Codex binary runs the whole turn -- spawn, tool execution, rollout
// persistence, app-server protocol -- while the model behind it is a deterministic script.
describe('Codex against a scripted model', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('completes a scripted tool turn end to end', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const marker = `GARCON_SCRIPTED_CODEX_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_DONE_${crypto.randomUUID().replaceAll('-', '')}`;
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_1', `echo ${marker}`)]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-model', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
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
      if (!bash) throw new Error('Scripted Codex shell tool use was not rendered.');
      const result = messagesOfType(transcript.messages, 'tool-result').find(
        (message) => message.toolId === bash.toolId,
      );
      expect(result?.isError).toBe(false);
      expect(JSON.stringify(result?.content)).toContain(marker);

      const requests = testEnvironment.model.requests();
      expect(requests).toHaveLength(2);
      expect(requests[0].lastUserText).toContain('Run the scripted command.');
      expect(requests[1].functionCallOutputs).toHaveLength(1);
      expect(requests[1].functionCallOutputs[0].callId).toBe('call_1');
      expect(requests[1].functionCallOutputs[0].output).toContain(marker);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment: testEnvironment.serverEnvironment,
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });

  test('holds a model request while the chat remains processing', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const reply = `SCRIPTED_HELD_${crypto.randomUUID().replaceAll('-', '')}`;
    const held = testEnvironment.model.scriptHeldTurn([codexAssistantMessage(reply)]);

    await withIntegrationFixture('codex-scripted-held-model', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(liveCodexStartRequest({
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
      prepareWorkspace: testEnvironment.prepareWorkspace,
    });
  });

  for (const fault of [
    { kind: 'http-error', status: 500, message: 'transient scripted HTTP failure' },
    { kind: 'stream-error', message: 'transient scripted SSE failure' },
    { kind: 'truncated-stream' },
  ] satisfies CodexScriptedFault[]) {
    test(`retries a transient ${fault.kind}`, async () => {
      if (!environment) throw new Error('Scripted Codex environment was not initialized.');
      const testEnvironment = environment;
      const reply = `SCRIPTED_FAULT_RECOVERY_${crypto.randomUUID().replaceAll('-', '')}`;
      const prompt = `Recover from the ${fault.kind} response.`;
      const requestStart = testEnvironment.model.requests().length;
      testEnvironment.model.scriptFault(fault);
      testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

      await withIntegrationFixture(`codex-scripted-${fault.kind}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveCodexStartRequest({
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
        expect(requests.map((request) => request.lastUserText)).toEqual([prompt, prompt]);
        testEnvironment.model.assertSettled();
      }, {
        serverEnvironment: testEnvironment.serverEnvironment,
        prepareWorkspace: testEnvironment.prepareWorkspace,
      });
    });
  }
});
