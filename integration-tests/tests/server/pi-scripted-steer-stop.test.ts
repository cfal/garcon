import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import { userContents } from '../../support/chat-assertions.js';
import { LIVE_TURN_TIMEOUT_MS, waitForVisibleResponse } from '../../support/live-agent.js';
import {
  piNativeSession,
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi steering stop semantics', () => {
  beforeEach(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('resends stopped steering whether or not Pi persisted it before interruption', async () => {
    const testEnvironment = requireEnvironment();
    const queuedBootstrapPrompt = marker('QUEUED_BOOTSTRAP_PROMPT');
    const queuedBootstrapReply = marker('QUEUED_BOOTSTRAP_REPLY');
    const queuedPrompt = marker('QUEUED_PROMPT');
    const queuedSteer = marker('QUEUED_STEER');
    const queuedRecoveryPrompt = marker('QUEUED_RECOVERY_PROMPT');
    const queuedRecoveryReply = marker('QUEUED_RECOVERY_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(queuedBootstrapReply)]);

    await withIntegrationFixture('pi-scripted-steer-stop', async (fixture) => {
      const queuedChatId = fixture.newChatId();
      const bootstrapCursor = fixture.client.markEvents();
      const bootstrap = await fixture.client.startChat(scriptedPiStartRequest({
        chatId: queuedChatId,
        projectPath: fixture.dirs.project,
        command: queuedBootstrapPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: queuedChatId,
        turnId: bootstrap.turnId,
        marker: queuedBootstrapReply,
        afterIndex: bootstrapCursor,
      });

      const queuedRequestCursor = testEnvironment.model.markRequests();
      const queuedHeld = testEnvironment.model.scriptHeldTurn([
        chatCompletionsText(marker('QUEUED_STOPPED_REPLY')),
      ]);
      const queuedTurn = await fixture.client.runChat(scriptedPiRunRequest({
        chatId: queuedChatId,
        command: queuedPrompt,
      }));
      if (!queuedTurn.turnId) throw new Error('Pi run response omitted its turn id.');
      await queuedHeld.requested;

      await expect(fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId: queuedChatId,
        content: queuedSteer,
      })).resolves.toMatchObject({ status: 'accepted', turnId: queuedTurn.turnId });

      const queuedStopCursor = fixture.client.markEvents();
      const queuedStop = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId: queuedChatId,
      });
      expect(queuedStop.outcome).toBe('interrupt-requested');
      await fixture.client.waitForProcessing(queuedChatId, false, {
        afterIndex: queuedStopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      queuedHeld.release();

      expect(userContents((await fixture.client.getMessages(queuedChatId)).messages))
        .toContain(queuedSteer);
      const queuedNative = await piNativeSession(fixture, queuedChatId);
      expect(await readFile(queuedNative.path, 'utf8')).not.toContain(queuedSteer);

      testEnvironment.model.scriptTurn([chatCompletionsText(queuedRecoveryReply)]);
      const queuedRecoveryCursor = fixture.client.markEvents();
      const queuedRecovery = await fixture.client.runChat(scriptedPiRunRequest({
        chatId: queuedChatId,
        command: queuedRecoveryPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: queuedChatId,
        turnId: queuedRecovery.turnId,
        marker: queuedRecoveryReply,
        afterIndex: queuedRecoveryCursor,
      });
      const queuedRequests = testEnvironment.model.requestsSince(queuedRequestCursor);
      expect(queuedRequests).toHaveLength(2);
      expect(queuedRequests[1].userTexts.join('\n')).toContain(queuedSteer);
      expect(queuedRequests[1].userTexts.at(-1)?.endsWith(queuedRecoveryPrompt)).toBe(true);

      const deliveredPrompt = marker('DELIVERED_PROMPT');
      const deliveredSteer = marker('DELIVERED_STEER');
      const deliveredRecoveryPrompt = marker('DELIVERED_RECOVERY_PROMPT');
      const deliveredRecoveryReply = marker('DELIVERED_RECOVERY_REPLY');
      const toolOutput = marker('DELIVERED_TOOL_OUTPUT');
      const startedFile = '.pi-steer-delivered-started';
      const releaseFile = '.pi-steer-delivered-release';
      const deliveredRequestCursor = testEnvironment.model.markRequests();
      testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_delivered_steer', 'bash', {
        command: `touch ${startedFile} && while [ ! -f ${releaseFile} ]; do sleep 0.05; done && printf %s ${toolOutput}`,
      })]);
      const deliveredHeld = testEnvironment.model.scriptHeldTurn([
        chatCompletionsText(marker('DELIVERED_STOPPED_REPLY')),
      ]);

      const deliveredChatId = fixture.newChatId();
      const deliveredTurn = await fixture.client.startChat(scriptedPiStartRequest({
        chatId: deliveredChatId,
        projectPath: fixture.dirs.project,
        command: deliveredPrompt,
      }));
      if (!deliveredTurn.turnId) throw new Error('Pi start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, startedFile));

      await expect(fixture.client.steer({
        clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(),
        chatId: deliveredChatId,
        content: deliveredSteer,
      })).resolves.toMatchObject({ status: 'accepted', turnId: deliveredTurn.turnId });
      await writeFile(join(fixture.dirs.project, releaseFile), '');
      const deliveredModelRequest = await deliveredHeld.requested;
      expect(deliveredModelRequest.userTexts.at(-1)).toBe(deliveredSteer);
      expect(deliveredModelRequest.toolResults).toContainEqual({
        toolCallId: 'call_delivered_steer',
        content: expect.stringContaining(toolOutput),
      });

      const deliveredStopCursor = fixture.client.markEvents();
      const deliveredStop = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId: deliveredChatId,
      });
      expect(deliveredStop.outcome).toBe('interrupt-requested');
      await fixture.client.waitForProcessing(deliveredChatId, false, {
        afterIndex: deliveredStopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      deliveredHeld.release();

      const deliveredNative = await piNativeSession(fixture, deliveredChatId);
      expect(await readFile(deliveredNative.path, 'utf8')).toContain(deliveredSteer);

      testEnvironment.model.scriptTurn([chatCompletionsText(deliveredRecoveryReply)]);
      const deliveredRecoveryCursor = fixture.client.markEvents();
      const deliveredRecovery = await fixture.client.runChat(scriptedPiRunRequest({
        chatId: deliveredChatId,
        command: deliveredRecoveryPrompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: deliveredChatId,
        turnId: deliveredRecovery.turnId,
        marker: deliveredRecoveryReply,
        afterIndex: deliveredRecoveryCursor,
      });
      const deliveredRequests = testEnvironment.model.requestsSince(deliveredRequestCursor);
      expect(deliveredRequests).toHaveLength(3);
      expect(deliveredRequests[2].userTexts.join('\n')).toContain(deliveredSteer);
      expect(deliveredRequests[2].userTexts.at(-1)?.endsWith(deliveredRecoveryPrompt)).toBe(true);
      expect(userContents((await fixture.client.getMessages(deliveredChatId)).messages))
        .toContain(deliveredSteer);
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(25);
    }
  }
  throw new Error(`Pi never created ${path}.`);
}

function marker(label: string): string {
  return `SCRIPTED_PI_STEER_STOP_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
