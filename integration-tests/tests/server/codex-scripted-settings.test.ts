import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionSettingsPatchResponse } from '../../../common/chat-command-contracts.js';
import { isRecord } from '../../../common/json.js';
import { codexAssistantMessage, codexExecCommandCall, type FakeCodexModel, type RecordedCodexModelRequest } from '../../support/fake-codex-model.js';
import { withIntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { createLiveCodexProtocolProbe, type LiveCodexProtocolProbe } from '../../support/live-codex-protocol-probe.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedCodexTestEnvironment, type ScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

function writeCommand(path: string, marker: string): string {
  const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
  return `printf %s ${marker} > ${quoted} && cat ${quoted}`;
}

function callOutput(request: RecordedCodexModelRequest, callId: string): string {
  const output = request.functionCallOutputs.find(output => output.callId === callId);
  expect(output).toBeDefined();
  return output!.output;
}

function permissionInstructions(request: RecordedCodexModelRequest): string {
  const input = Array.isArray(request.body.input) ? request.body.input : [];
  const texts = input.flatMap(item => isRecord(item) && item.role === 'developer' && Array.isArray(item.content)
    ? item.content.flatMap(part => isRecord(part) && typeof part.text === 'string' ? [part.text] : []) : []);
  return texts.filter(text => text.includes('<permissions instructions>')).at(-1) ?? '';
}

function scriptSandboxedEscalation(model: FakeCodexModel, outsidePath: string, marker: string): void {
  const command = writeCommand(outsidePath, marker);
  model.scriptTurn([codexExecCommandCall('call_sandboxed', command)]);
  model.scriptTurn(request => {
    expect(callOutput(request, 'call_sandboxed')).not.toMatch(/Process exited with code 0(?:\n|$)/);
    return [codexExecCommandCall('call_escalated', command, {
      sandbox_permissions: 'require_escalated', justification: 'synthetic outside-workspace write',
    })];
  });
  model.scriptTurn(request => {
    expect(callOutput(request, 'call_escalated')).toMatch(/Process exited with code 0(?:\n|$)/);
    return [codexAssistantMessage(marker)];
  });
}

describe('scripted Codex session settings', () => {
  let environment: ScriptedCodexTestEnvironment;
  let protocol: LiveCodexProtocolProbe;
  let fixtureOptions: IntegrationFixtureOptions;
  beforeEach(async () => {
    environment = await startScriptedCodexTestEnvironment();
    const serverEnvironment = { ...environment.serverEnvironment };
    protocol = createLiveCodexProtocolProbe(serverEnvironment);
    fixtureOptions = {
      authentication: 'account', bindAddress: '0.0.0.0', serverEnvironment,
      prepareWorkspace: async directories => {
        await environment.prepareWorkspace(directories);
        await protocol.prepareWorkspace(directories);
      },
    };
  });
  afterEach(async () => { await environment.dispose(); });

  test('rejects active effort clearing and applies confirmed permissions at the next turn', async () => {
    await withIntegrationFixture('codex-settings-active', async fixture => {
      const outsidePath = join(fixture.dirs.workspace, 'synthetic-settings-output');
      const held = environment.model.scriptHeldTurn([
        codexExecCommandCall('call_running', writeCommand(outsidePath, 'synthetic-running')),
      ]);
      environment.model.scriptTurn(request => {
        expect(callOutput(request, 'call_running')).toMatch(/Process exited with code 0(?:\n|$)/);
        return [codexAssistantMessage('synthetic settings reply')];
      });
      try {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveCodexStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'synthetic settings input', permissionMode: 'bypassPermissions',
        }));
        await held.requested;
        await expect(fixture.client.patch('/api/v1/chats/execution-settings', { chatId, thinkingMode: 'none' }))
          .rejects.toMatchObject({ status: 422, body: { errorCode: 'VALIDATION_FAILED', retryable: false } });
        expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.thinkingMode).toBe('low');
        expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
          chatId, permissionMode: 'manualBypass',
        })).toMatchObject({ success: true, permissionMode: 'manualBypass', thinkingMode: 'low' });
        held.release();
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor,
          marker: 'synthetic settings reply' });
        expect(await readFile(outsidePath, 'utf8')).toBe('synthetic-running');
        const requests = environment.model.requests();
        expect(requests).toHaveLength(2);
        expect(permissionInstructions(requests[1]!)).toContain('danger-full-access');
        expect(await protocol.readApprovalRequests()).toEqual([]);

        scriptSandboxedEscalation(environment.model, outsidePath, 'synthetic-next-turn');
        const resumedCursor = fixture.client.markEvents();
        const resumed = await fixture.client.runChat({ chatId, command: 'synthetic next input',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await waitForVisibleResponse({ fixture, chatId, turnId: resumed.turnId, afterIndex: resumedCursor,
          marker: 'synthetic-next-turn' });
        expect(await readFile(outsidePath, 'utf8')).toBe('synthetic-next-turn');
        expect(await protocol.readApprovalRequests()).toEqual(['item/commandExecution/requestApproval']);
        expect(permissionInstructions(environment.model.requests().at(-1)!)).toContain('workspace-write');
        environment.model.assertSettled();
      } finally { held.release(); }
    }, fixtureOptions);
  }, 120_000);

  test('retains active manual-bypass approval while saving default permissions for the next turn', async () => {
    await withIntegrationFixture('codex-settings-active-approval', async fixture => {
      const outsidePath = join(fixture.dirs.workspace, 'synthetic-settings-approval');
      const held = environment.model.scriptHeldTurn([codexExecCommandCall('call_active_escalation',
        writeCommand(outsidePath, 'synthetic-active-approval'), {
          sandbox_permissions: 'require_escalated', justification: 'synthetic active-turn approval',
        })]);
      environment.model.scriptTurn(request => {
        expect(callOutput(request, 'call_active_escalation')).toMatch(/Process exited with code 0(?:\n|$)/);
        return [codexAssistantMessage('synthetic active approval reply')];
      });
      try {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(liveCodexStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'synthetic approval input', permissionMode: 'manualBypass',
        }));
        await held.requested;
        expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
          chatId, permissionMode: 'default',
        })).toMatchObject({ success: true, permissionMode: 'default' });
        held.release();
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor,
          marker: 'synthetic active approval reply' });
        expect(await readFile(outsidePath, 'utf8')).toBe('synthetic-active-approval');
        expect(await protocol.readApprovalRequests()).toEqual(['item/commandExecution/requestApproval']);

        environment.model.scriptTurn([codexExecCommandCall('call_refused_escalation',
          writeCommand(outsidePath, 'synthetic-forbidden'), {
            sandbox_permissions: 'require_escalated', justification: 'synthetic next-turn refusal',
          })]);
        environment.model.scriptTurn(request => {
          expect(callOutput(request, 'call_refused_escalation')).not.toMatch(/Process exited with code 0(?:\n|$)/);
          return [codexAssistantMessage('synthetic refused escalation reply')];
        });
        const resumedCursor = fixture.client.markEvents();
        const resumed = await fixture.client.runChat({ chatId, command: 'synthetic next input',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await waitForVisibleResponse({ fixture, chatId, turnId: resumed.turnId, afterIndex: resumedCursor,
          marker: 'synthetic refused escalation reply' });
        expect(await readFile(outsidePath, 'utf8')).toBe('synthetic-active-approval');
        expect(await protocol.readApprovalRequests()).toEqual(['item/commandExecution/requestApproval']);
        expect(permissionInstructions(environment.model.requests().at(-1)!)).toContain('Approval policy is currently never.');
        environment.model.assertSettled();
      } finally { held.release(); }
    }, fixtureOptions);
  }, 120_000);

  for (const restart of [false, true]) {
    test(`preserves saved idle settings and native identity after restart=${restart}`, async () => {
      environment.model.scriptTurn([codexAssistantMessage('synthetic initial reply')]);
      await withIntegrationFixture(`codex-settings-idle-${restart}`, async fixture => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const first = await fixture.client.startChat(liveCodexStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'synthetic initial input', permissionMode: 'bypassPermissions',
        }));
        await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, afterIndex: cursor,
          marker: 'synthetic initial reply' });
        const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' });
        if (restart) await fixture.restartGarcon();
        expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
          chatId, permissionMode: 'manualBypass',
        })).toMatchObject({ success: true, permissionMode: 'manualBypass' });
        expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
          chatId, thinkingMode: 'none',
        })).toMatchObject({ success: true, thinkingMode: 'none' });
        const outsidePath = join(fixture.dirs.workspace, 'synthetic-idle-settings');
        scriptSandboxedEscalation(environment.model, outsidePath, 'synthetic-resumed-reply');
        const resumedCursor = fixture.client.markEvents();
        const resumed = await fixture.client.runChat({ chatId, command: 'synthetic resumed input',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await waitForVisibleResponse({ fixture, chatId, turnId: resumed.turnId, afterIndex: resumedCursor,
          marker: 'synthetic-resumed-reply' });
        expect(await readFile(outsidePath, 'utf8')).toBe('synthetic-resumed-reply');
        expect(await protocol.readApprovalRequests()).toEqual(['item/commandExecution/requestApproval']);
        const request = environment.model.requests().at(-1)!;
        const permissions = permissionInstructions(request);
        expect(permissions).toContain('workspace-write');
        expect(permissions).toContain('require_escalated');
        expect(permissions).not.toContain('Approval policy is currently never.');
        expect(request.body.reasoning).toMatchObject({ effort: 'low' });
        expect((await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'codex' })).agentSessionId)
          .toBe(native.agentSessionId);
        environment.model.assertSettled();
      }, fixtureOptions);
    }, 120_000);
  }
});
