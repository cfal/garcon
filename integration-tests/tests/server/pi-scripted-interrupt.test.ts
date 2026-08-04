import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ServerWsMessage } from '../../../common/ws-events.js';
import { assistantContents } from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  scriptedPiRunRequest,
  scriptedPiStartRequest,
  startScriptedPiTestEnvironment,
  type ScriptedPiTestEnvironment,
} from '../../support/scripted-pi.js';

// Locks the CURRENT transport's stop contract: the JSON runtime stops by killing the process,
// and the RPC switch must preserve the same observable behavior.
let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi interrupt lifecycle', () => {
  beforeAll(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterAll(() => {
    environment?.dispose();
  });

  test('stops an active tool turn and preserves the stopped transcript shape', async () => {
    const testEnvironment = requireEnvironment();
    const stoppedReply = marker('SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('RECOVERY_REPLY');
    const stoppedPrompt = marker('STOPPED_PROMPT');
    const recoveryPrompt = marker('RECOVERY_PROMPT');
    const startedFile = '.pi-scripted-stop-started';
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_stopped', 'bash', {
      command: `touch ${startedFile} && sleep 30`,
    })]);

    await withIntegrationFixture('pi-scripted-interrupt', async (fixture) => {
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(scriptedPiStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: stoppedPrompt,
      }));
      if (!active.turnId) throw new Error('Pi start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, startedFile));

      const stopCursor = fixture.client.markEvents();
      const stopped = await fixture.client.stopChat({
        clientRequestId: crypto.randomUUID(),
        chatId,
      });
      expect(stopped.outcome).toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, {
        afterIndex: stopCursor,
        timeoutMs: LIVE_TURN_TIMEOUT_MS,
      });
      expectPiStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .not.toContain(stoppedReply);

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
      const assistants = assistantContents((await fixture.client.getMessages(chatId)).messages);
      expect(assistants.some((content) => content.includes(recoveryReply))).toBe(true);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

  // A stop before Pi has persisted anything leaves no session file, and the current
  // transport then fails the next turn's --session lookup ("No session found"). That wart is
  // not locked here on purpose: the RPC runtime establishes identity before the first prompt,
  // and Suite D covers the held-model stop after the switch.
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

// Pi's current stop order differs from Claude's: the provider-level kill drops processing to
// idle before the coordinator publishes chat-session-stopped (Claude publishes stopped before
// idle). The RPC switch must preserve this exact observable sequence.
function expectPiStoppedTurnEventOrder(
  events: readonly ServerWsMessage[],
  chatId: string,
  turnId: string,
): void {
  const stopping = events.findIndex((event) =>
    event.type === 'chat-processing-updated'
    && event.chatId === chatId
    && event.phase === 'stopping');
  const idle = events.findIndex((event) =>
    event.type === 'chat-processing-updated'
    && event.chatId === chatId
    && event.phase === null);
  const stopped = events.findIndex((event) =>
    event.type === 'chat-session-stopped'
    && event.chatId === chatId
    && event.intent === 'stop'
    && event.outcome === 'interrupt-requested');

  expect(stopping).toBeGreaterThanOrEqual(0);
  expect(idle).toBeGreaterThan(stopping);
  expect(stopped).toBeGreaterThan(idle);
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'agent-run-failed',
    chatId,
    turnId,
  }));
}

function marker(label: string): string {
  return `SCRIPTED_PI_INTERRUPT_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
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
