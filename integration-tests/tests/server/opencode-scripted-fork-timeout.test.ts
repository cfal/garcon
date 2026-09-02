import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { assistantContents, userContents } from '../../support/chat-assertions.js';
import { chatCompletionsText } from '../../support/fake-chat-completions-model.js';
import {
  withIntegrationFixture,
  type IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { OpenCodeTransportController } from '../../support/opencode-transport-controller.js';
import {
  openCodeNativeSession,
  scriptedOpenCodeRunRequest,
  scriptedOpenCodeStartRequest,
  startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment | undefined;

const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;
const FORMER_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;

describeOnLinux('scripted OpenCode long-running fork', () => {
  beforeEach(() => {
    environment = startScriptedOpenCodeTestEnvironment({ proxy: true });
  });

  afterEach(() => {
    environment?.dispose();
    environment = undefined;
  });

  test('waits for native replay beyond the ordinary request timeout without warning spam', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('SOURCE_PROMPT');
    const reply = marker('SOURCE_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-long-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const cursor = fixture.client.markEvents();
      const sourceTurn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await waitForVisibleResponse({
        fixture,
        chatId: sourceChatId,
        turnId: sourceTurn.turnId,
        marker: reply,
        afterIndex: cursor,
      });

      const sourceNative = await openCodeNativeSession(fixture, sourceChatId);
      const forkPath = `/session/${encodeURIComponent(sourceNative.agentSessionId)}/fork`;
      const transport = OpenCodeTransportController.forFixture(fixture.dirs);
      await transport.holdNextResponse(forkPath);
      const forkChatId = fixture.newChatId();
      const outcome = fixture.client.forkChat({ sourceChatId, chatId: forkChatId }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error) => ({ status: 'rejected' as const, error }),
      );
      const responseId = await transport.waitForResponseHeld(forkPath);

      try {
        const beforeRelease = await Promise.race([
          outcome,
          Bun.sleep(FORMER_OPENCODE_REQUEST_TIMEOUT_MS + 250).then(() => 'still-pending' as const),
        ]);
        expect(beforeRelease).toBe('still-pending');
      } finally {
        await transport.releaseResponse(responseId);
      }

      const forkResult = await outcome;
      if (forkResult.status === 'rejected') throw forkResult.error;
      expect(forkResult.value.chat.id).toBe(forkChatId);
      const fork = await fixture.client.getMessages(forkChatId);
      expect(userContents(fork.messages)).toEqual([prompt]);
      expect(assistantContents(fork.messages)).toEqual([reply]);
      const forkNative = await openCodeNativeSession(fixture, forkChatId);
      expect(unroutedWarningSessionIds(
        fixture.diagnostics().processRuns.flatMap((run) => run.serverLogs),
      )).not.toContain(forkNative.agentSessionId);
      testEnvironment.model.assertSettled();
    }, withScriptedOpenCode());
  }, 120_000);

  test('finishes replay and deletes the native child when fork-run admission is stopped', async () => {
    const testEnvironment = requireEnvironment();
    const prompt = marker('CANCEL_SOURCE_PROMPT');
    const reply = marker('CANCEL_SOURCE_REPLY');
    testEnvironment.model.scriptTurn([chatCompletionsText(reply)]);

    await withIntegrationFixture('opencode-cancelled-fork', async (fixture) => {
      const sourceChatId = fixture.newChatId();
      const sourceTurn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
        chatId: sourceChatId,
        projectPath: fixture.dirs.project,
        command: prompt,
      }));
      await fixture.client.waitForTurnTerminal(sourceChatId, sourceTurn.turnId);

      const sourceNative = await openCodeNativeSession(fixture, sourceChatId);
      const forkPath = `/session/${encodeURIComponent(sourceNative.agentSessionId)}/fork`;
      const transport = OpenCodeTransportController.forFixture(fixture.dirs);
      await transport.holdNextResponse(forkPath);
      const forkChatId = fixture.newChatId();
      const outcome = fixture.client.forkRunChat({
        ...scriptedOpenCodeRunRequest({
          chatId: forkChatId,
          command: marker('CANCELLED_FORK_PROMPT'),
        }),
        sourceChatId,
      }).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error) => ({ status: 'rejected' as const, error }),
      );
      const responseId = await transport.waitForResponseHeld(forkPath);

      const stopping = fixture.garcon.stop();
      await waitForGarconLog(() => fixture.garcon.logs, 'server: shutting down...');
      expect((await transport.requests()).some((request) => request.method === 'DELETE')).toBe(false);
      await transport.releaseResponse(responseId);
      const deleted = await transport.waitForRequest('DELETE', '/session/');
      expect(deleted.path).not.toBe(`/session/${encodeURIComponent(sourceNative.agentSessionId)}`);
      await stopping;
      expect((await outcome).status).toBe('rejected');
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
  return `SCRIPTED_OPENCODE_FORK_${label}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function unroutedWarningSessionIds(lines: readonly string[]): string[] {
  const sessionIds: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.includes('Ignoring an OpenCode event without an operation identity')) {
      continue;
    }
    const detail = lines.slice(index + 1, index + 12).find((line) => line.includes('sessionId:'));
    const match = detail?.match(/sessionId: "([^"]+)"/);
    if (match?.[1]) sessionIds.push(match[1]);
  }
  return sessionIds;
}

async function waitForGarconLog(
  readLines: () => readonly string[],
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (readLines().some((line) => line.includes(marker))) return;
    await Bun.sleep(15);
  }
  throw new Error(`Garcon never logged ${marker}.`);
}
