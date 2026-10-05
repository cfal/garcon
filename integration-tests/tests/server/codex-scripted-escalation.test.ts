import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from '../../../cli/shell-quote.js';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
} from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
  codexWriteStdinCall,
} from '../../support/fake-codex-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexRunRequest, liveCodexStartRequest } from '../../support/live-codex.js';
import { createLiveCodexProtocolProbe } from '../../support/live-codex-protocol-probe.js';
import {
  startScriptedCodexTestEnvironment,
  type ScriptedCodexTestEnvironment,
} from '../../support/scripted-codex.js';

describe('scripted Codex escalation', () => {
  let environment: ScriptedCodexTestEnvironment | undefined;

  beforeAll(async () => {
    environment = await startScriptedCodexTestEnvironment();
  });

  afterAll(async () => {
    await environment?.dispose();
  });

  test('auto-approves one escalate-first command in manual bypass', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const serverEnvironment = { ...testEnvironment.serverEnvironment };
    const protocolProbe = createLiveCodexProtocolProbe(serverEnvironment);
    const marker = `SCRIPTED_CODEX_ESCALATE_FIRST_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CODEX_ESCALATE_FIRST_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const outsidePath = join(process.cwd(), `.scripted-codex-${crypto.randomUUID()}`);
    const command = `printf %s ${marker} > ${shellQuote(outsidePath)} && cat ${shellQuote(outsidePath)}`;
    testEnvironment.model.scriptTurn([
      codexExecCommandCall('call_escalated', command, {
        sandbox_permissions: 'require_escalated',
        justification: 'test requires writing outside the workspace',
      }),
    ]);
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

    try {
      await withIntegrationFixture('codex-scripted-escalate-first', async (fixture) => {
        const chatId = fixture.newChatId();
        const prompt = `Run the scripted escalate-first command for ${marker}.`;
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveCodexStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: prompt,
          permissionMode: 'manualBypass',
        }));
        await waitForVisibleResponse({
          fixture,
          chatId,
          turnId: turn.turnId,
          marker: reply,
          afterIndex: cursor,
        });

        expect((await readFile(outsidePath, 'utf8')).trim()).toBe(marker);
        expect(await protocolProbe.waitForApprovalRequest()).toBe(
          'item/commandExecution/requestApproval',
        );
        expect(await protocolProbe.readApprovalRequests()).toEqual([
          'item/commandExecution/requestApproval',
        ]);
        const streamed = await fixture.client.getMessages(chatId);
        const executions = expectExecutions(
          streamed,
          command,
          marker,
          1,
        );
        expect(messagesOfType(streamed.messages, 'permission-request')).toEqual([]);
        await fixture.restartGarcon();
        const restored = await fixture.client.getMessages(chatId);
        expect(expectExecutions(restored, command, marker, 1)).toEqual(executions);
        expect(messagesOfType(restored.messages, 'permission-request')).toEqual([]);
        expect(countUserContent(restored.messages, prompt)).toBe(1);
        testEnvironment.model.assertSettled();
      }, {
        serverEnvironment,
        prepareWorkspace: async (directories) => {
          await testEnvironment.prepareWorkspace(directories);
          await protocolProbe.prepareWorkspace(directories);
        },
      });
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  test('persists the streamed escalated retry without reconciling native-only output', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const serverEnvironment = { ...testEnvironment.serverEnvironment };
    const protocolProbe = createLiveCodexProtocolProbe(serverEnvironment);
    const marker = `SCRIPTED_CODEX_SANDBOX_RETRY_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CODEX_SANDBOX_RETRY_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const prompt = `Run the scripted sandbox-first command for ${marker}.`;
    const outsidePath = join(homedir(), `.scripted-codex-${crypto.randomUUID()}`);
    const command = `printf %s ${marker} > ${shellQuote(outsidePath)} && cat ${shellQuote(outsidePath)}`;
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_sandboxed', command)]);
    testEnvironment.model.scriptTurn((request) => {
      const failed = request.functionCallOutputs.find(
        (output) => output.callId === 'call_sandboxed',
      );
      if (!failed) throw new Error('Sandboxed attempt output never reached the model.');
      if (/Process exited with code 0(?:\n|$)/.test(failed.output)) {
        throw new Error('Codex sandbox capability probe unexpectedly allowed the outside write.');
      }
      testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);
      return [codexExecCommandCall('call_escalated_retry', command, {
        sandbox_permissions: 'require_escalated',
        justification: 'sandbox denied the write',
      })];
    });

    try {
      await withIntegrationFixture('codex-scripted-sandbox-retry', async (fixture) => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveCodexStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: prompt,
          permissionMode: 'manualBypass',
        }));
        await waitForVisibleResponse({
          fixture,
          chatId,
          turnId: turn.turnId,
          marker: reply,
          afterIndex: cursor,
        });

        expect((await readFile(outsidePath, 'utf8')).trim()).toBe(marker);
        expect(await protocolProbe.waitForApprovalRequest()).toBe(
          'item/commandExecution/requestApproval',
        );
        expect(await protocolProbe.readApprovalRequests()).toEqual([
          'item/commandExecution/requestApproval',
        ]);

        const streamed = await fixture.client.getMessages(chatId);
        // A sandbox-denied native attempt exists only in Codex's rollout. Garcon persists the
        // streamed escalated retry and does not reconcile the native-only attempt into history.
        const streamedExecutions = expectExecutions(streamed, command, marker, 1);
        expect(assistantContents(streamed.messages).some((content) => content.includes(reply)))
          .toBe(true);

        await fixture.restartGarcon();
        const restored = await fixture.client.getMessages(chatId);
        expect(expectExecutions(restored, command, marker, 1)).toEqual(streamedExecutions);
        expect(countUserContent(restored.messages, prompt)).toBe(1);
        testEnvironment.model.assertSettled();
      }, {
        serverEnvironment,
        prepareWorkspace: async (directories) => {
          await testEnvironment.prepareWorkspace(directories);
          await protocolProbe.prepareWorkspace(directories);
        },
      });
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  test('keeps repeated write-stdin approvals distinct for one native command', async () => {
    if (!environment) throw new Error('Scripted Codex environment was not initialized.');
    const testEnvironment = environment;
    const serverEnvironment = { ...testEnvironment.serverEnvironment };
    const protocolProbe = createLiveCodexProtocolProbe(serverEnvironment);
    const firstMarker = `SCRIPTED_CODEX_STDIN_FIRST_${crypto.randomUUID().replaceAll('-', '')}`;
    const secondMarker = `SCRIPTED_CODEX_STDIN_SECOND_${crypto.randomUUID().replaceAll('-', '')}`;
    const reply = `SCRIPTED_CODEX_STDIN_REPLY_${crypto.randomUUID().replaceAll('-', '')}`;
    const terminalCommand = '/bin/bash --noprofile --norc';
    let sessionId = 0;
    await withIntegrationFixture('codex-scripted-stdin-approvals', async (fixture) => {
      testEnvironment.model.scriptTurn([
        codexExecCommandCall('open_terminal', terminalCommand, {
          tty: true,
          yield_time_ms: 200,
          sandbox_permissions: 'require_escalated',
          justification: 'test requires an unsandboxed interactive terminal',
        }),
      ]);
      testEnvironment.model.scriptTurn((request) => {
        const opened = request.functionCallOutputs.find(
          (output) => output.callId === 'open_terminal',
        );
        const match = opened?.output.match(/Process running with session ID (\d+)/);
        sessionId = Number(match?.[1]);
        if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
          throw new Error(`Interactive terminal did not remain open: ${opened?.output}`);
        }
        return [codexAssistantMessage('Terminal opened.')];
      });
      testEnvironment.model.scriptTurn(() => [
        codexWriteStdinCall('stdin_first', sessionId, `printf '%s\\n' ${firstMarker}\n`),
      ]);
      testEnvironment.model.scriptTurn((request) => {
        const first = request.functionCallOutputs.find(
          (output) => output.callId === 'stdin_first',
        );
        if (!first) throw new Error('First stdin output never reached the model.');
        return [codexWriteStdinCall(
          'stdin_second',
          sessionId,
          `printf '%s\\n' ${secondMarker}; exit\n`,
        )];
      });
      testEnvironment.model.scriptTurn((request) => {
        const second = request.functionCallOutputs.find(
          (output) => output.callId === 'stdin_second',
        );
        if (!second?.output.includes(secondMarker)) {
          throw new Error(`Second stdin output did not contain its marker: ${second?.output}`);
        }
        return [codexAssistantMessage(reply)];
      });

      const chatId = fixture.newChatId();
      const openCursor = fixture.client.markEvents();
      const opened = await fixture.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.dirs.project,
        command: 'Open the scripted interactive terminal.',
        permissionMode: 'manualBypass',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: opened.turnId,
        marker: 'Terminal opened.',
        afterIndex: openCursor,
      });
      const commandItemIds = await protocolProbe.readCommandItemIds();
      expect(commandItemIds).toHaveLength(1);

      const writeCursor = fixture.client.markEvents();
      const written = await fixture.client.runChat(liveCodexRunRequest({
        chatId,
        command: 'Write twice to the scripted interactive terminal.',
        permissionMode: 'manualBypass',
      }));
      await waitForVisibleResponse({
        fixture,
        chatId,
        turnId: written.turnId,
        marker: reply,
        afterIndex: writeCursor,
      });

      const approvals = (await protocolProbe.readApprovalRequestDetails())
        .filter((entry) => entry.kind === 'writeStdin');
      expect(approvals).toHaveLength(2);
      expect(approvals.map((entry) => entry.approvalId)).toEqual([
        'stdin_first',
        'stdin_second',
      ]);
      expect(new Set(approvals.map((entry) => entry.approvalId)).size).toBe(2);
      expect(approvals.map((entry) => entry.itemId)).toEqual([
        commandItemIds[0],
        commandItemIds[0],
      ]);
      expect(messagesOfType((await fixture.client.getMessages(chatId)).messages, 'permission-request'))
        .toEqual([]);
      testEnvironment.model.assertSettled();
    }, {
      serverEnvironment,
      prepareWorkspace: async (directories) => {
        await testEnvironment.prepareWorkspace(directories);
        await protocolProbe.prepareWorkspace(directories);
      },
    });
  }, 120_000);
});

function expectExecutions(
  transcript: Awaited<ReturnType<GarconTestClient['getMessages']>>,
  command: string,
  marker: string,
  executionCount: number,
): Array<{
  readonly command: string;
  readonly content: Record<string, unknown>;
  readonly isError: boolean;
}> {
  const commands = messagesOfType(transcript.messages, 'bash-tool-use').filter(
    (message) => message.command === command,
  );
  expect(commands).toHaveLength(executionCount);
  const results = messagesOfType(transcript.messages, 'tool-result');
  const executions = commands.map((bash) => {
    const result = results.find((message) => message.toolId === bash.toolId);
    if (!result) throw new Error(`Codex execution ${bash.toolId} has no result.`);
    return {
      command: bash.command,
      content: result.content,
      isError: result.isError,
    };
  });
  expect(executions.filter((execution) => !execution.isError)).toEqual([{
    command,
    content: { raw: marker },
    isError: false,
  }]);
  return executions;
}
