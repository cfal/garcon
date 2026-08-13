import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assistantContents,
  countUserContent,
  messagesOfType,
} from '../../support/chat-assertions.js';
import {
  codexAssistantMessage,
  codexExecCommandCall,
} from '../../support/fake-codex-model.js';
import type { GarconTestClient } from '../../support/garcon-client.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
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
    const command = `printf %s ${marker} > ${outsidePath} && cat ${outsidePath}`;
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
        expectSuccessfulExecution(
          await fixture.client.getMessages(chatId),
          command,
          marker,
          1,
        );
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
    const outsidePath = join(process.cwd(), `.scripted-codex-${crypto.randomUUID()}`);
    const command = `printf %s ${marker} > ${outsidePath} && cat ${outsidePath}`;
    testEnvironment.model.scriptTurn([codexExecCommandCall('call_sandboxed', command)]);
    testEnvironment.model.scriptTurn((request) => {
      const failed = request.functionCallOutputs.find(
        (output) => output.callId === 'call_sandboxed',
      );
      if (!failed) throw new Error('Sandboxed attempt output never reached the model.');
      if (/Process exited with code 0(?:\n|$)/.test(failed.output)) {
        throw new Error('Codex sandbox capability probe unexpectedly allowed the outside write.');
      }
      return [codexExecCommandCall('call_escalated_retry', command, {
        sandbox_permissions: 'require_escalated',
        justification: 'sandbox denied the write',
      })];
    });
    testEnvironment.model.scriptTurn([codexAssistantMessage(reply)]);

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

        // The sandbox failure exists only in Codex's rollout. The ledger stores
        // the successful retry that Codex emitted live and never reconciles the
        // native-only attempt into ordinary history.
        const streamed = await fixture.client.getMessages(chatId);
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
});

function expectSuccessfulExecution(
  transcript: Awaited<ReturnType<GarconTestClient['getMessages']>>,
  command: string,
  marker: string,
  executionCount: number,
): void {
  expect(expectExecutions(transcript, command, marker, executionCount)
    .filter((execution) => !execution.isError)).toHaveLength(1);
}

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
