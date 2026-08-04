import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
} from '../../support/integration-fixture.js';
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
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('discards queued steering but preserves steering already delivered at a boundary', async () => {
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

      const queuedSteerRequestId = crypto.randomUUID();
      await expect(fixture.client.steer({
        clientRequestId: queuedSteerRequestId,
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

      const queuedPending = await waitForPendingStatus(
        fixture,
        queuedChatId,
        queuedSteerRequestId,
        'unconfirmed',
      );
      expect(queuedPending.content).toBe(queuedSteer);
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
      expect(queuedRequests[1].userTexts).not.toContain(queuedSteer);
      expect(queuedRequests[1].userTexts.at(-1)).toBe(queuedRecoveryPrompt);

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

      const deliveredSteerRequestId = crypto.randomUUID();
      await expect(fixture.client.steer({
        clientRequestId: deliveredSteerRequestId,
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
      expect(deliveredRequests[2].userTexts).toContain(deliveredSteer);
      expect(deliveredRequests[2].userTexts.at(-1)).toBe(deliveredRecoveryPrompt);
      await waitForPendingRemoval(fixture, deliveredChatId, deliveredSteerRequestId);
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

async function waitForPendingStatus(
  fixture: IntegrationFixture,
  chatId: string,
  clientRequestId: string,
  deliveryStatus: string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pending = (await fixture.client.getMessages(chatId)).pendingUserInputs.find(
      (input) => input.clientRequestId === clientRequestId && input.deliveryStatus === deliveryStatus,
    );
    if (pending) return pending;
    await Bun.sleep(25);
  }
  throw new Error(`Pi pending input ${clientRequestId} never reached ${deliveryStatus}.`);
}

async function waitForPendingRemoval(
  fixture: IntegrationFixture,
  chatId: string,
  clientRequestId: string,
): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pending = (await fixture.client.getMessages(chatId)).pendingUserInputs.find(
      (input) => input.clientRequestId === clientRequestId,
    );
    if (!pending) return;
    await Bun.sleep(25);
  }
  throw new Error(`Pi pending input ${clientRequestId} was not reconciled.`);
}

function marker(label: string): string {
  return `SCRIPTED_PI_STEER_STOP_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
