import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  ChatSessionStoppedMessage,
  ServerWsMessage,
} from '../../../common/ws-events.js';
import {
  assistantContents,
  messagesOfType,
  userContents,
} from '../../support/chat-assertions.js';
import {
  chatCompletionsText,
  chatCompletionsToolUse,
} from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import {
  LIVE_TURN_TIMEOUT_MS,
  waitForVisibleResponse,
} from '../../support/live-agent.js';
import {
  openCodeNativeSession,
  readOpenCodeSessionRows,
  readSupervisorStates,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  waitForSupervisorExit,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';
import {
  linuxProcessStartTimeTicks,
  processIdentityAlive,
  type OpenCodeProcessIdentity,
  type OpenCodeProcessState,
} from '../../support/opencode-process-supervisor.js';

// Stop flows through the real binary: Garcon's abort reaches OpenCode's session.abort, the
// active model request or shell tool dies, and no provider failure is fabricated for a
// user-requested stop.
let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode interrupt lifecycle', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment();
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('stops a held active model turn exactly once and recovers on the next turn', async () => {
    const testEnvironment = requireEnvironment();
    const stoppedReply = marker('SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('RECOVERY_REPLY');
    const held = testEnvironment.model.scriptHeldTurn([chatCompletionsText(stoppedReply)]);

    await withIntegrationFixture('opencode-interrupt-held-turn', async (fixture) => {
      const chatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const active = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: marker('HELD_PROMPT'),
      }));
      if (!active.turnId) throw new Error('OpenCode start response omitted its turn id.');
      await held.requested;

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
      // chat-session-stopped trails the idle processing update; await it explicitly before
      // asserting the ordered sequence.
      await fixture.client.waitForEvent(
        (event): event is ChatSessionStoppedMessage =>
          event.type === 'chat-session-stopped'
          && event.chatId === chatId
          && event.intent === 'stop',
        'opencode stop confirmation',
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectOpenCodeStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );

      // The recovery begins immediately after Garcon confirms the stop. The abort endpoint
      // does not return until OpenCode has interrupted its session runner.
      held.release();

      testEnvironment.model.reset();
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });

      // No late assistant output landed under the stopped turn.
      expect(fixture.client.eventsSince(stopCursor).some((event) =>
        event.type === 'chat-messages'
        && event.chatId === chatId
        && event.turnId === active.turnId
        && event.messages.some((entry) =>
          entry.message.type === 'assistant-message'
          && entry.message.content.includes(stoppedReply))
      )).toBe(false);
      expect(assistantContents((await fixture.client.getMessages(chatId)).messages).join('\n'))
        .not.toContain(stoppedReply);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('stops an active shell tool and preserves the stopped transcript shape', async () => {
    const testEnvironment = requireEnvironment();
    const stoppedReply = marker('TOOL_SHOULD_NOT_COMPLETE');
    const recoveryReply = marker('TOOL_RECOVERY_REPLY');
    const stoppedPrompt = marker('TOOL_STOPPED_PROMPT');
    const command = [
      'sleep 30 & child=$!',
      'printf "%s %s" "$$" "$child" > stop-pids.marker',
      'touch stop-started.marker',
      'wait "$child"',
      'touch stop-completed.marker',
    ].join('; ');
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_stopped_tool', 'bash', {
      command,
    })]);
    testEnvironment.model.scriptTurn([chatCompletionsText(stoppedReply)]);

    await withIntegrationFixture('opencode-interrupt-active-tool', async (fixture) => {
      const chatId = fixture.newChatId();
      const active = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: stoppedPrompt,
      }));
      if (!active.turnId) throw new Error('OpenCode start response omitted its turn id.');
      await waitForFile(join(fixture.dirs.project, 'stop-started.marker'));
      const processIds = (await readFile(
        join(fixture.dirs.project, 'stop-pids.marker'),
        'utf8',
      )).trim().split(/\s+/).map(Number);
      const processIdentities = processIds.map((pid) => ({
        pid,
        startTimeTicks: linuxProcessStartTimeTicks(pid),
      }));
      expect(processIdentities.every((identity) =>
        processIdentityAlive(identity.pid, identity.startTimeTicks)
      )).toBe(true);

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
        (event): event is ChatSessionStoppedMessage =>
          event.type === 'chat-session-stopped'
          && event.chatId === chatId
          && event.intent === 'stop',
        'opencode stop confirmation',
        { afterIndex: stopCursor, timeoutMs: LIVE_TURN_TIMEOUT_MS },
      );
      expectOpenCodeStoppedTurnEventOrder(
        fixture.client.eventsSince(stopCursor),
        chatId,
        active.turnId,
      );
      await waitForAbortedAssistant(fixture, chatId);
      await waitForProcessesExit(processIdentities);
      // Both the command shell and its active child died before the completion marker.
      await expect(access(join(fixture.dirs.project, 'stop-completed.marker')))
        .rejects.toMatchObject({ code: 'ENOENT' });

      // OpenCode publishes tool parts on completion, so the aborted tool's late events are
      // fenced: the stopped transcript holds the user prompt with no assistant output and no
      // fabricated failure. The native DB records the killed tool and the abort unwind.
      const stoppedTranscript = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(stoppedTranscript)).toContain(stoppedPrompt);
      expect(assistantContents(stoppedTranscript).join('\n')).not.toContain(stoppedReply);
      expect(messagesOfType(stoppedTranscript, 'error')).toEqual([]);
      const native = await openCodeNativeSession(fixture, chatId);
      const rows = readOpenCodeSessionRows(native);
      const toolPart = rows.parts.find((row) => row.data.type === 'tool');
      expect(toolPart?.data.tool).toBe('bash');
      expect(JSON.stringify(toolPart?.data.state)).toContain(command.slice(0, 24));
      const abortedAssistant = rows.messages.find((row) => row.data.role === 'assistant');
      expect((abortedAssistant?.data.error as { name?: string } | undefined)?.name)
        .toBe('MessageAbortedError');

      const previousSupervisors = await readSupervisorStates(fixture.dirs);
      expect(previousSupervisors).toHaveLength(1);
      await fixture.restartGarcon({
        beforeStart: () => waitForSupervisorExit(previousSupervisors),
      });
      const restored = (await fixture.client.getMessages(chatId)).messages;
      expect(userContents(restored)).toContain(stoppedPrompt);
      expect(assistantContents(restored).join('\n')).not.toContain(stoppedReply);
      expect(messagesOfType(restored, 'error')).toEqual([]);
      expect(messagesOfType(restored, 'bash-tool-use').some(
        (message) => message.command === command,
      )).toBe(false);

      testEnvironment.model.reset();
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.runChat(scriptedOpenCodeRunRequest({
        chatId,
        command: marker('TOOL_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('kills the provider process tree before replacing a crashed Garcon', async () => {
    const testEnvironment = requireEnvironment();
    const command = [
      "trap '' TERM",
      'sleep 30 & child=$!',
      'printf "%s %s" "$$" "$child" > crash-pids.marker',
      'touch crash-started.marker',
      'wait "$child"',
      'touch crash-completed.marker',
    ].join('; ');
    testEnvironment.model.scriptTurn([chatCompletionsToolUse('call_crash_tool', 'bash', {
      command,
    })]);

    await withIntegrationFixture('opencode-crash-active-tool', async (fixture) => {
      await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: fixture.newChatId(),
        projectPath: fixture.dirs.project,
        command: marker('CRASH_TOOL_PROMPT'),
      }));
      await waitForFile(join(fixture.dirs.project, 'crash-started.marker'));
      const processIds = (await readFile(
        join(fixture.dirs.project, 'crash-pids.marker'),
        'utf8',
      )).trim().split(/\s+/).map(Number);
      const processIdentities = processIds.map((pid) => ({
        pid,
        startTimeTicks: linuxProcessStartTimeTicks(pid),
      }));
      expect(processIdentities.every((identity) =>
        processIdentityAlive(identity.pid, identity.startTimeTicks)
      )).toBe(true);

      const crashedSupervisors = await waitForRecordedProviderProcessTree(
        fixture,
        processIdentities,
      );
      await fixture.crashAndRestartGarcon({
        beforeStart: async () => {
          await waitForSupervisorExit(crashedSupervisors);
          expect(processIdentities.every((identity) =>
            !processIdentityAlive(identity.pid, identity.startTimeTicks)
          )).toBe(true);
          await expect(access(join(fixture.dirs.project, 'crash-completed.marker')))
            .rejects.toMatchObject({ code: 'ENOENT' });
        },
      });

      testEnvironment.model.reset();
      const recoveryReply = marker('CRASH_TOOL_RECOVERY_REPLY');
      testEnvironment.model.scriptTurn([chatCompletionsText(recoveryReply)]);
      const recoveryChatId = fixture.newChatId();
      const recoveryCursor = fixture.client.markEvents();
      const recovery = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: recoveryChatId,
        projectPath: fixture.dirs.project,
        command: marker('CRASH_TOOL_RECOVERY_PROMPT'),
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: recoveryChatId,
        turnId: recovery.turnId,
        marker: recoveryReply,
        afterIndex: recoveryCursor,
      });
      testEnvironment.model.assertSettled();
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
  return `SCRIPTED_OPENCODE_INTERRUPT_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

// OpenCode drops processing to idle before the coordinator publishes chat-session-stopped.
function expectOpenCodeStoppedTurnEventOrder(
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

// Waits until OpenCode persisted the aborted turn's terminal assistant state.
async function waitForAbortedAssistant(
  fixture: IntegrationFixture,
  chatId: string,
): Promise<void> {
  const native = await openCodeNativeSession(fixture, chatId);
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = readOpenCodeSessionRows(native);
    const assistant = rows.messages.find((row) => row.data.role === 'assistant');
    const time = assistant?.data.time;
    if (
      assistant
      && (assistant.data.error !== undefined
        || (time !== null && typeof time === 'object'
          && (time as Record<string, unknown>).completed !== undefined))
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error('OpenCode never settled the aborted assistant message.');
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
  throw new Error(`OpenCode never created ${path}.`);
}

async function waitForProcessesExit(
  identities: Array<{ pid: number; startTimeTicks: string | null }>,
): Promise<void> {
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (identities.every((identity) =>
      !processIdentityAlive(identity.pid, identity.startTimeTicks)
    )) return;
    await Bun.sleep(25);
  }
  const survivors = identities.filter((identity) =>
    processIdentityAlive(identity.pid, identity.startTimeTicks)
  ).map(({ pid }) => pid);
  throw new Error(`OpenCode shell processes survived abort: ${survivors.join(', ')}`);
}

async function waitForRecordedProviderProcessTree(
  fixture: IntegrationFixture,
  identities: Array<{ pid: number; startTimeTicks: string | null }>,
): Promise<OpenCodeProcessState[]> {
  const expected = identities.filter((identity): identity is OpenCodeProcessIdentity =>
    identity.startTimeTicks !== null);
  const deadline = Date.now() + LIVE_TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const states = await readSupervisorStates(fixture.dirs);
    const recorded = states.flatMap((state) => state.providerOwnedProcesses);
    if (expected.every((identity) => recorded.some((candidate) =>
      candidate.pid === identity.pid && candidate.startTimeTicks === identity.startTimeTicks
    ))) return states;
    await Bun.sleep(25);
  }
  throw new Error(
    `OpenCode supervisor never recorded tool identities ${expected.map(({ pid }) => pid).join(', ')}.`,
  );
}
