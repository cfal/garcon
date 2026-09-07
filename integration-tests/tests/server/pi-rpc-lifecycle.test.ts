import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
  beforeEach(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
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
      // A visible failed run is a resend boundary; the user decides whether to retry it.
      expect(transcript.resendCandidates).toEqual([]);
      expect(assistantContents(transcript.messages).some((text) => text.includes(firstReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);
  // Journal-first crash: rows committed to the ledger while Pi's native
  // persistence was lost. The reopened segment serves the committed rows
  // unchanged, fences the unpersisted tail instead of diverging, and the
  // next turn resumes from the truncated provider context.
  test('serves journalled rows and resumes after a crash lost native persistence', async () => {
    const testEnvironment = requireEnvironment();
    const firstPrompt = marker('CRASH_FIRST_PROMPT');
    const firstReply = marker('CRASH_FIRST_REPLY');
    const lostPrompt = marker('CRASH_LOST_PROMPT');
    const lostReply = marker('CRASH_LOST_REPLY');
    const recoveryPrompt = marker('CRASH_RECOVERY_PROMPT');
    const recoveryReply = marker('CRASH_RECOVERY_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(firstReply)]);

    await withIntegrationFixture('pi-journal-first-crash', async (fixture) => {
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
      const beforeLostTurn = await readFile(native.path, 'utf8');

      testEnvironment.model.scriptTurn([chatCompletionsText(lostReply)]);
      const lostCursor = fixture.client.markEvents();
      const lost = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: lostPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: lost.turnId,
        marker: lostReply,
        afterIndex: lostCursor,
      });

      // The crash loses Pi's native persistence of the finished turn while
      // the ledger keeps its committed rows.
      await writeFile(native.path, beforeLostTurn);
      await fixture.restartGarcon();

      const restored = await fixture.client.getMessages(chatId);
      expect(userContents(restored.messages)).toEqual([firstPrompt, lostPrompt]);
      expect(assistantContents(restored.messages).join('\n')).toContain(lostReply);

      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedPiRunRequest({
        chatId,
        command: recoveryPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      const transcript = await fixture.client.getMessages(chatId);
      expect(userContents(transcript.messages)).toEqual([
        firstPrompt,
        lostPrompt,
        recoveryPrompt,
      ]);
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
