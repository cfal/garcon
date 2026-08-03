import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../../common/chat-command-contracts.js';
import { assistantContents } from '../../support/chat-assertions.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  expectStoppedTurnEventOrder,
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  liveClaudeRunRequest,
  liveClaudeStartRequest,
} from '../../support/live-claude.js';
import {
  liveCodexRunRequest,
  liveCodexStartRequest,
} from '../../support/live-codex.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

interface HeldModelTurn {
  readonly requested: Promise<unknown>;
  release(): void;
}

interface SteeringContractDriver {
  readonly id: string;
  readonly serverEnvironment: Record<string, string>;
  readonly prepareWorkspace?: (directories: IntegrationDirectories) => Promise<void>;
  startRequest(input: {
    chatId: string;
    projectPath: string;
    command: string;
  }): StartChatCommandRequest;
  runRequest(input: { chatId: string; command: string }): AgentRunCommandRequest;
  holdReply(reply: string): HeldModelTurn;
  scriptReply(reply: string): void;
  markRequests(): number;
  userTextsSince(cursor: number): readonly string[];
  assertSettled(): void;
  reset(): void;
}

interface SteeringContractEnvironment {
  readonly driver: SteeringContractDriver;
  dispose(): void | Promise<void>;
}

function defineSteeringConformance(
  providerName: string,
  startEnvironment: () => Promise<SteeringContractEnvironment>,
): void {
  describe(`${providerName} scripted steering conformance`, () => {
    let environment: SteeringContractEnvironment | undefined;

    beforeAll(async () => {
      environment = await startEnvironment();
    });

    afterAll(async () => {
      await environment?.dispose();
    });

    test('does not execute accepted guidance after stop', async () => {
      if (!environment) throw new Error(`${providerName} environment was not initialized.`);
      const { driver } = environment;
      const firstPrompt = marker(driver.id, 'STOP_FIRST_PROMPT');
      const steerPrompt = marker(driver.id, 'STOP_STEER_PROMPT');
      const cancelledReply = marker(driver.id, 'STOP_CANCELLED_REPLY');
      const recoveryPrompt = marker(driver.id, 'STOP_RECOVERY_PROMPT');
      const recoveryReply = marker(driver.id, 'STOP_RECOVERY_REPLY');
      const requestCursor = driver.markRequests();
      const held = driver.holdReply(cancelledReply);

      try {
        await withIntegrationFixture(`${driver.id}-scripted-steering-stop`, async (fixture) => {
          const chatId = fixture.newChatId();
          const active = await fixture.client.startChat(driver.startRequest({
            chatId,
            projectPath: fixture.dirs.project,
            command: firstPrompt,
          }));
          if (!active.turnId) throw new Error(`${providerName} omitted the active turn id.`);
          await held.requested;

          expect(await fixture.client.steer({
            clientRequestId: crypto.randomUUID(),
            clientMessageId: crypto.randomUUID(),
            chatId,
            content: steerPrompt,
          })).toMatchObject({ status: 'accepted', turnId: active.turnId });

          const stopCursor = fixture.client.markEvents();
          expect(await fixture.client.stopChat({
            clientRequestId: crypto.randomUUID(),
            chatId,
          })).toMatchObject({ outcome: 'interrupt-requested' });
          await fixture.client.waitForProcessing(chatId, false, {
            afterIndex: stopCursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
          await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
            afterIndex: stopCursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          });
          expectStoppedTurnEventOrder(
            fixture.client.eventsSince(stopCursor),
            chatId,
            active.turnId,
          );

          held.release();
          driver.scriptReply(recoveryReply);
          const recoveryCursor = fixture.client.markEvents();
          const recovery = await fixture.client.runChat(driver.runRequest({
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

          const sampledUserText = driver.userTextsSince(requestCursor).join('\n');
          expect(sampledUserText).not.toContain(steerPrompt);
          expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
            .not.toContain(cancelledReply);
          driver.assertSettled();
        }, {
          serverEnvironment: driver.serverEnvironment,
          prepareWorkspace: driver.prepareWorkspace,
        });
      } finally {
        held.release();
        driver.reset();
      }
    }, 120_000);
  });
}

defineSteeringConformance('Claude', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  return {
    driver: {
      id: 'claude',
      serverEnvironment: environment.serverEnvironment,
      startRequest: liveClaudeStartRequest,
      runRequest: liveClaudeRunRequest,
      holdReply: (reply) => environment.model.scriptHeldTurn([claudeText(reply)]),
      scriptReply: (reply) => environment.model.scriptTurn([claudeText(reply)]),
      markRequests: () => environment.model.markRequests(),
      userTextsSince: (cursor) => environment.model.requestsSince(cursor)
        .flatMap((request) => request.userTexts),
      assertSettled: () => environment.model.assertSettled(),
      reset: () => environment.model.reset(),
    },
    dispose: () => environment.dispose(),
  };
});

defineSteeringConformance('Codex', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  return {
    driver: {
      id: 'codex',
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: environment.prepareWorkspace,
      startRequest: liveCodexStartRequest,
      runRequest: liveCodexRunRequest,
      holdReply: (reply) => environment.model.scriptHeldTurn([codexAssistantMessage(reply)]),
      scriptReply: (reply) => environment.model.scriptTurn([codexAssistantMessage(reply)]),
      markRequests: () => environment.model.markRequests(),
      userTextsSince: (cursor) => environment.model.requestsSince(cursor)
        .flatMap((request) => request.userTexts),
      assertSettled: () => environment.model.assertSettled(),
      reset: () => environment.model.reset(),
    },
    dispose: () => environment.dispose(),
  };
});

function marker(provider: string, label: string): string {
  return `SCRIPTED_${provider.toUpperCase()}_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
