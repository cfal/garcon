import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import {
  piNativeSession,
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

let environment: ScriptedPiTestEnvironment | undefined;

describe('Pi RPC lifecycle', () => {
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('fails resume instead of silently creating a session when the native file disappears', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('FIRST_PROMPT');
    const firstReply = marker('FIRST_REPLY');
    const missingFilePrompt = marker('MISSING_FILE_PROMPT');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);

    await withIntegrationFixture('pi-rpc-missing-session', async (fixture) => {
      const chatId = fixture.newChatId();
      const firstCursor = fixture.client.markEvents();
      const first = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: firstPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: first.turnId,
        marker: firstReply,
        afterIndex: firstCursor,
      });
      const native = await piNativeSession(fixture, chatId);
      await rm(native.path);
      const requestCursor = testEnvironment.model.markRequests();

      const failureCursor = fixture.client.markEvents();
      const failed = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: missingFilePrompt,
      }));
      const terminal = await fixture.client.waitForTurnTerminal(chatId, failed.turnId, {
        afterIndex: failureCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expect(terminal.type).toBe('agent-run-failed');
      expect(testEnvironment.model.requestsSince(requestCursor)).toEqual([]);

      const persisted = await piNativeSession(fixture, chatId);
      expect(persisted).toEqual(native);
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toContain(missingFilePrompt);
      // The failed input remains visible as a failed optimistic message but never reaches Pi.
      expect(transcript.pendingUserInputs).toContainEqual(expect.objectContaining({
        content: missingFilePrompt,
        deliveryStatus: 'failed',
      }));
      expect(assistantContents(transcript.messages).some((text) => text.includes(firstReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);
});

function requireEnvironment(): ScriptedPiTestEnvironment {
  if (!environment) throw new Error('Scripted Pi environment was not initialized.');
  return environment;
}

function withScriptedPi(): {
  serverEnvironment: Record<string, string>;
  prepareWorkspace: ScriptedPiTestEnvironment['prepareWorkspace'];
} {
  const testEnvironment = requireEnvironment();
  return {
    serverEnvironment: testEnvironment.serverEnvironment,
    prepareWorkspace: testEnvironment.prepareWorkspace,
  };
}

function marker(label: string): string {
  return `SCRIPTED_PI_RPC_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
