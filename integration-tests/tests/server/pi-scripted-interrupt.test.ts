import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PrimaryWsServerMessage as ServerWsMessage } from '../../../common/ws-protocol.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
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

// Locks Pi's process-kill stop contract. The RPC abort command is deliberately not used because
// it can restart queued steering as a continuation.
let environment: ScriptedPiTestEnvironment | undefined;

describe('scripted Pi interrupt lifecycle', () => {
  beforeEach(() => {
    environment = startScriptedPiTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('kills preparation before any model request and respawns for the next operation', async () => {
    environment?.dispose();
    environment = startScriptedPiTestEnvironment({ extensionSource: `
import { access, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export default function (pi) {
  pi.on('session_start', async (_event, ctx) => {
    await appendFile(join(ctx.cwd, '.pi-scripted-processes'), process.pid + '\\n');
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType !== 'user' || event.prompt !== 'hold-preflight') return;
    await writeFile(join(ctx.cwd, '.pi-scripted-preflight'), 'ready');
    while (true) {
      try { await access(join(ctx.cwd, '.pi-scripted-release')); break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
}
` });
    const testEnvironment = requireEnvironment();
    testEnvironment.model.scriptTurn([chatCompletionsText('bootstrap finished')]);
    await withIntegrationFixture('pi-scripted-preflight-stop', async (fixture) => {
      const chatId = fixture.newChatId();
      const initialCursor = fixture.client.markEvents();
      const initial = await fixture.client.startChat(scriptedPiStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'bootstrap history',
      }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: initial.turnId, marker: 'bootstrap finished', afterIndex: initialCursor,
      });
      await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'hold-preflight' }));
      await waitForFile(join(fixture.dirs.project, '.pi-scripted-preflight'));
      const oldPid = Number((await readFile(join(fixture.dirs.project, '.pi-scripted-processes'), 'utf8')).trim());
      expect(Number.isInteger(oldPid) && oldPid > 0).toBe(true);
      const cursor = fixture.client.markEvents();
      expect((await fixture.client.stopChat({ chatId, clientRequestId: crypto.randomUUID() })).outcome)
        .toBe('interrupt-requested');
      await fixture.client.waitForProcessing(chatId, false, { afterIndex: cursor });
      await waitForProcessExit(oldPid);
      await writeFile(join(fixture.dirs.project, '.pi-scripted-release'), 'released');
      expect(testEnvironment.model.requests()).toHaveLength(1);
      testEnvironment.model.scriptTurn([chatCompletionsText('preflight recovery finished')]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedPiRunRequest({ chatId, command: 'recover preparation' }));
      await waitForVisibleResponse({
        fixture, chatId, turnId: recovery.turnId, marker: 'preflight recovery finished', afterIndex: recoveryCursor,
      });
      expect(testEnvironment.model.requests()).toHaveLength(2);
      expect(testEnvironment.model.requests().at(-1)?.lastUserText.endsWith('recover preparation')).toBe(true);
      const pids = (await readFile(join(fixture.dirs.project, '.pi-scripted-processes'), 'utf8')).trim().split('\n');
      expect(pids).toHaveLength(2);
      expect(new Set(pids).size).toBe(2);
      testEnvironment.model.assertSettled();
    }, withScriptedPi());
  }, 120_000);

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
    testEnvironment.model.scriptTurn([chatCompletionsText(stoppedReply)]);

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
      await fixture.client.waitForEvent(
        (event): event is ServerWsMessage => event.type === 'chat-session-stopped'
          && event.chatId === chatId,
        `${chatId} chat-session-stopped`,
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectPiStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      const stoppedTranscript = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(stoppedTranscript)).toContain(stoppedPrompt);
      expect(messagesOfType(stoppedTranscript, 'bash-tool-use')).toContainEqual(
        expect.objectContaining({ command: `touch ${startedFile} && sleep 30` }),
      );
      expect(assistantContents(stoppedTranscript).join('\n')).not.toContain(stoppedReply);

      testEnvironment.model.reset();
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

  // A stop before Pi persists the first turn leaves only the ready-time session identity. The
  // steering stop suite bootstraps history before testing recovery from a held model response.
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
  const interruption = events.findIndex((event) =>
    event.type === 'chat-messages'
    && event.chatId === chatId
    && event.turnId === turnId);

  expect(interruption).toBeGreaterThanOrEqual(0);
  expect(stopped).toBeGreaterThan(interruption);
  expect(idle).toBeGreaterThan(stopped);
  if (stopping >= 0) expect(idle).toBeGreaterThan(stopping);
  expect(events).not.toContainEqual(expect.objectContaining({
    type: 'agent-run-failed',
    chatId,
    turnId,
  }));
}

function marker(label: string): string {
  return `SCRIPTED_PI_INTERRUPT_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await Bun.sleep(20);
  }
  throw new Error(`Stopped turn left Pi process ${pid} running`);
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
