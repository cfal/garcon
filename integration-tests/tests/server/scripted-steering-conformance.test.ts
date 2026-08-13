import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AgentRunCommandRequest, StartChatCommandRequest } from '../../../common/chat-command-contracts.js';
import type { ChatSessionStoppedMessage } from '../../../common/ws-events.js';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import {
  type IntegrationDirectories,
  withIntegrationFixture,
} from '../../support/integration-fixture.js';
import {
  expectStoppedTurnEventOrder,
  expectFinished,
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
import {
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

interface HeldModelTurn {
  readonly requested: Promise<unknown>;
  release(): void;
}

interface SteeringContractDriver {
  readonly id: string;
  readonly serverEnvironment?: Record<string, string>;
  readonly resolveServerEnvironment?: (
    directories: IntegrationDirectories,
  ) => Record<string, string>;
  readonly prepareWorkspace?: (directories: IntegrationDirectories) => Promise<void>;
  readonly afterGarconStop?: (directories: IntegrationDirectories) => Promise<void>;
  readonly extraDiagnostics?: (
    directories: IntegrationDirectories,
  ) => Record<string, unknown>;
  readonly emitsTurnTerminalOnStop?: boolean;
  startRequest(input: {
    chatId: string;
    projectPath: string;
    command: string;
  }): StartChatCommandRequest;
  runRequest(input: { chatId: string; command: string }): Omit<AgentRunCommandRequest, 'transcriptViewId'>;
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

    test('uses the FIFO queue head as same-turn steering input exactly once', async () => {
      if (!environment) throw new Error(`${providerName} environment was not initialized.`);
      const { driver } = environment;
      const firstPrompt = marker(driver.id, 'QUEUE_FIRST_PROMPT');
      const steerPrompt = marker(driver.id, 'QUEUE_STEER_PROMPT');
      const futurePrompt = marker(driver.id, 'QUEUE_FUTURE_PROMPT');
      const firstReply = marker(driver.id, 'QUEUE_FIRST_REPLY');
      const steerReply = marker(driver.id, 'QUEUE_STEER_REPLY');
      const futureReply = marker(driver.id, 'QUEUE_FUTURE_REPLY');
      const held = driver.holdReply(firstReply);
      driver.scriptReply(steerReply);
      driver.scriptReply(futureReply);

      try {
        await withIntegrationFixture(`${driver.id}-scripted-queue-steering`, async (fixture) => {
          const chatId = fixture.newChatId();
          const activeCursor = fixture.client.markEvents();
          const active = await fixture.client.startChat(driver.startRequest({
            chatId,
            projectPath: fixture.dirs.project,
            command: firstPrompt,
          }));
          if (!active.turnId) throw new Error(`${providerName} omitted the active turn id.`);
          await held.requested;

          await fixture.client.enqueueNew(chatId, steerPrompt);
          await fixture.client.enqueueNew(chatId, futurePrompt);
          const paused = await fixture.client.pauseQueue(chatId);
          expect(paused.control.queue.entries.map((entry) => entry.content)).toEqual([
            steerPrompt,
            futurePrompt,
          ]);
          const source = paused.control.queue.entries[0];
          if (!source) throw new Error(`${providerName} omitted the queued steer source.`);
          const request = {
            clientRequestId: crypto.randomUUID(),
            clientMessageId: crypto.randomUUID(),
            chatId,
            entryId: source.id,
            expectedRevision: source.revision,
            expectedReorderRevision: paused.control.queue.reorderRevision,
          };

          const steered = await fixture.client.steerQueued(request);
          const duplicate = await fixture.client.steerQueued(request);

          expect(steered).toMatchObject({ status: 'accepted', turnId: active.turnId });
          expect(duplicate).toMatchObject({ status: 'duplicate', turnId: active.turnId });
          expect(steered.control?.queue.entries.map((entry) => entry.content)).toEqual([futurePrompt]);
          expect(steered.control?.queue.pause).toEqual(paused.control.queue.pause);
          expect(steered.control?.queue.recentlyDispatched).toContainEqual(expect.objectContaining({
            entryId: source.id,
            revision: source.revision,
          }));

          held.release();
          expectFinished((await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
            afterIndex: activeCursor,
            timeoutMs: LIVE_TURN_TIMEOUT_MS,
          })).type);

          const stillPaused = await fixture.client.getExecutionControl(chatId);
          expect(stillPaused.queue.entries.map((entry) => entry.content)).toEqual([futurePrompt]);
          expect(stillPaused.queue.pause).toEqual(paused.control.queue.pause);
          expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual([
            firstPrompt,
            steerPrompt,
          ]);

          const futureCursor = fixture.client.markEvents();
          await fixture.client.resumeQueue(chatId, stillPaused.queue.pause!.id);
          const futureInput = await fixture.client.waitForCommittedUserInput(
            chatId,
            futurePrompt,
            { afterIndex: futureCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
          );
          const futureTerminal = await fixture.client.waitForTurnTerminal(
            chatId,
            undefined,
            {
              afterIndex: fixture.client.events().lastIndexOf(futureInput) + 1,
              timeoutMs: LIVE_TURN_TIMEOUT_MS,
            },
          );
          expect(futureTerminal.turnId).not.toBe(active.turnId);
          expectFinished(futureTerminal.type);

          const transcript = await fixture.client.getMessages(chatId);
          expect(userContents(transcript.messages)).toEqual([
            firstPrompt,
            steerPrompt,
            futurePrompt,
          ]);
          const assistants = assistantContents(transcript.messages);
          expect(assistants.some((content) => content.includes(steerReply))).toBe(true);
          expect(assistants.some((content) => content.includes(futureReply))).toBe(true);
          driver.assertSettled();
        }, {
          serverEnvironment: driver.serverEnvironment,
          resolveServerEnvironment: driver.resolveServerEnvironment,
          prepareWorkspace: driver.prepareWorkspace,
          afterGarconStop: driver.afterGarconStop,
          extraDiagnostics: driver.extraDiagnostics,
        });
      } finally {
        held.release();
        driver.reset();
      }
    }, 120_000);

    test('keeps accepted guidance durable across best-effort stop', async () => {
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
          if (driver.emitsTurnTerminalOnStop === false) {
            await fixture.client.waitForEvent(
              (event): event is ChatSessionStoppedMessage =>
                event.type === 'chat-session-stopped'
                && event.chatId === chatId
                && event.intent === 'stop',
              `${providerName} stop confirmation`,
              { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
            );
          } else {
            await fixture.client.waitForTurnTerminal(chatId, active.turnId, {
              afterIndex: stopCursor,
              timeoutMs: LIVE_TURN_TIMEOUT_MS,
            });
            expectStoppedTurnEventOrder(
              fixture.client.eventsSince(stopCursor),
              chatId,
              active.turnId,
            );
          }

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
          expect(sampledUserText).toContain(steerPrompt);
          expect(sampledUserText).toContain(recoveryPrompt);
          expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
            .toContain(recoveryReply);
          driver.assertSettled();
        }, {
          serverEnvironment: driver.serverEnvironment,
          resolveServerEnvironment: driver.resolveServerEnvironment,
          prepareWorkspace: driver.prepareWorkspace,
          afterGarconStop: driver.afterGarconStop,
          extraDiagnostics: driver.extraDiagnostics,
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

if (process.platform === 'linux') {
  defineSteeringConformance('OpenCode', async () => {
    const environment = startScriptedOpenCodeTestEnvironment();
    return {
      driver: {
        id: 'opencode',
        resolveServerEnvironment: environment.resolveServerEnvironment,
        prepareWorkspace: environment.prepareWorkspace,
        afterGarconStop: environment.afterGarconStop,
        extraDiagnostics: environment.extraDiagnostics,
        emitsTurnTerminalOnStop: false,
        startRequest: scriptedOpenCodeStartRequest,
        runRequest: scriptedOpenCodeRunRequest,
        holdReply: (reply) => environment.model.scriptHeldTurn([chatCompletionsText(reply)]),
        scriptReply: (reply) => environment.model.scriptTurn([chatCompletionsText(reply)]),
        markRequests: () => environment.model.markRequests(),
        userTextsSince: (cursor) => environment.model.requestsSince(cursor)
          .flatMap((request) => request.userTexts),
        assertSettled: () => environment.model.assertSettled(),
        reset: () => environment.model.reset(),
      },
      dispose: () => environment.dispose(),
    };
  });
}

function marker(provider: string, label: string): string {
  return `SCRIPTED_${provider.toUpperCase()}_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}
