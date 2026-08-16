import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  readSupervisorStates,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('OpenCode V1 context exhaustion against a scripted model', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment({ autoCompact: true });
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('[TLV5-OPENCODE.01-SCRIPTED-01] reports one attributed failure without automatic continuation', async () => {
    const testEnvironment = requireEnvironment();
    const overflow = marker('OVERFLOW');
    const prompt = marker('PROMPT');
    const requestCursor = testEnvironment.model.markRequests();
    testEnvironment.model.scriptFault({
      kind: 'http-error',
      status: 400,
      message: overflow,
      code: 'context_length_exceeded',
    });
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('FORBIDDEN_SUMMARY'))]);
    testEnvironment.model.scriptTurn([chatCompletionsText(marker('FORBIDDEN_CONTINUATION'))]);

    await withIntegrationFixture('opencode-scripted-context-exhaustion', async (fixture) => {
      const chatId = fixture.newChatId();
      const eventCursor = fixture.client.markEvents();
      const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));

      const terminal = await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: eventCursor,
        timeoutMs: 30_000,
      });
      expect(terminal).toMatchObject({
        type: 'agent-run-failed',
        chatId,
        turnId: turn.turnId,
      });
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: eventCursor,
        timeoutMs: 30_000,
      });

      const transcript = await fixture.client.getMessages(chatId);
      expect(transcript.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'error',
      ]);
      expect(userContents(transcript.messages)).toEqual([prompt]);
      expect(assistantContents(transcript.messages)).toEqual([]);
      expect(messagesOfType(transcript.messages, 'error')).toHaveLength(1);
      expect(testEnvironment.model.requestsSince(requestCursor)).toHaveLength(1);

      const terminals = fixture.client.eventsSince(eventCursor).filter((event) =>
        (event.type === 'agent-run-failed' || event.type === 'agent-run-finished')
        && event.chatId === chatId
        && event.turnId === turn.turnId);
      expect(terminals).toEqual([
        expect.objectContaining({ type: 'agent-run-failed', chatId, turnId: turn.turnId }),
      ]);

      testEnvironment.model.reset();
      const previousSupervisors = await readSupervisorStates(fixture.dirs);
      expect(previousSupervisors).toHaveLength(1);
      await fixture.restartGarcon({
        beforeStart: () => waitForSupervisorExit(previousSupervisors),
      });

      const restored = await fixture.client.getMessages(chatId);
      expect(restored.messages.map((entry) => entry.message.type)).toEqual([
        'user-message',
        'error',
      ]);
      expect(userContents(restored.messages)).toEqual([prompt]);
      expect(assistantContents(restored.messages)).toEqual([]);
    }, withScriptedOpenCode());
  }, 120_000);
});

function requireEnvironment(): ScriptedOpenCodeTestEnvironment {
  if (!environment) throw new Error('Scripted OpenCode environment was not initialized.');
  return environment;
}

function withScriptedOpenCode(): IntegrationFixtureOptions {
  const testEnvironment = requireEnvironment();
  return {
    resolveServerEnvironment: testEnvironment.resolveServerEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
    afterGarconStop: testEnvironment.afterGarconStop,
    extraDiagnostics: testEnvironment.extraDiagnostics,
  };
}

function marker(label: string): string {
  return `SCRIPTED_OPENCODE_COMPACTION_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
