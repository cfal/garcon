import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PermissionMode } from '../../../common/chat-modes.js';
import type { ExecutionSettingsPatchResponse } from '../../../common/chat-command-contracts.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { chatCompletionsText, chatCompletionsToolUse } from '../../support/fake-chat-completions-model.js';
import { withIntegrationFixture, type IntegrationFixture, type IntegrationFixtureOptions } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { OpenCodeTransportController } from '../../support/opencode-transport-controller.js';
import {
  OPENCODE_TEST_REASONING_MODEL, openCodeNativeSession, readOpenCodeSessionPermission,
  scriptedOpenCodeStartRequest, startScriptedOpenCodeTestEnvironment,
  type ScriptedOpenCodeTestEnvironment,
} from '../../support/scripted-opencode.js';

let environment: ScriptedOpenCodeTestEnvironment;
const describeOnLinux = process.platform === 'linux' ? describe : describe.skip;

describeOnLinux('scripted OpenCode session settings', () => {
  beforeEach(() => { environment = startScriptedOpenCodeTestEnvironment({ proxy: true }); });
  afterEach(() => { environment.dispose(); });

  for (const [previous, next] of [['default', 'manualBypass'], ['manualBypass', 'default']] as const) {
    test(`changes the active permission route from ${previous} to ${next}`, async () => {
      const held = environment.model.scriptHeldTurn([chatCompletionsToolUse('call_settings_bash', 'bash', {
        command: 'printf synthetic-settings-output > settings-output.txt',
      })]);
      environment.model.scriptTurn([chatCompletionsText('synthetic settings reply')]);
      try {
        await withIntegrationFixture(`opencode-settings-live-${next}`, async fixture => {
          const chatId = fixture.newChatId();
          const cursor = fixture.client.markEvents();
          const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
            chatId, projectPath: fixture.dirs.project, command: 'synthetic settings input', permissionMode: previous,
          }));
          await held.requested;
          const native = await openCodeNativeSession(fixture, chatId);
          const rules = readOpenCodeSessionPermission(native);
          await savePermission(fixture, chatId, next);
          held.release();
          if (next === 'default') await allowNextPermission(fixture, chatId, cursor);
          await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor,
            marker: 'synthetic settings reply' });
          expect(await readFile(join(fixture.dirs.project, 'settings-output.txt'), 'utf8'))
            .toBe('synthetic-settings-output');
          const permissions = messagesOfType((await fixture.client.getMessages(chatId)).messages, 'permission-request');
          expect(permissions).toHaveLength(next === 'default' ? 1 : 0);
          expect(readOpenCodeSessionPermission(native)).toEqual(rules);
          expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(0);
          environment.model.assertSettled();
        }, options());
      } finally { held.release(); }
    }, 120_000);
  }

  test('defers acceptEdits until the next turn and does not append rules on unchanged resumes', async () => {
    await withIntegrationFixture('opencode-settings-deferred', async fixture => {
      const chatId = fixture.newChatId();
      const firstPath = join(fixture.dirs.project, 'settings-first.txt');
      const held = environment.model.scriptHeldTurn([chatCompletionsToolUse('call_settings_first', 'write', {
        filePath: firstPath, content: 'synthetic first content\n',
      })]);
      environment.model.scriptTurn([chatCompletionsText('synthetic first reply')]);
      try {
        const cursor = fixture.client.markEvents();
        const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'synthetic first input', permissionMode: 'default',
        }));
        await held.requested;
        const native = await openCodeNativeSession(fixture, chatId);
        const original = readOpenCodeSessionPermission(native);
        await savePermission(fixture, chatId, 'acceptEdits');
        expect(readOpenCodeSessionPermission(native)).toEqual(original);
        held.release();
        await allowNextPermission(fixture, chatId, cursor);
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor,
          marker: 'synthetic first reply' });
        expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(0);

        const nextPath = join(fixture.dirs.project, 'settings-next.txt');
        environment.model.scriptTurn([chatCompletionsToolUse('call_settings_next', 'write', {
          filePath: nextPath, content: 'synthetic next content\n',
        })]);
        environment.model.scriptTurn([chatCompletionsText('synthetic next reply')]);
        await resume(fixture, chatId, 'synthetic next reply');
        expect(await readFile(nextPath, 'utf8')).toBe('synthetic next content\n');
        const reconciled = readOpenCodeSessionPermission(native);
        expect(reconciled?.length).toBe((original?.length ?? 0) + 3);
        expect(reconciled?.slice(-3)).toEqual(acceptEditsRules);
        for (let turnIndex = 0; turnIndex < 3; turnIndex += 1) {
          environment.model.scriptTurn([chatCompletionsText('synthetic unchanged reply')]);
          await resume(fixture, chatId, 'synthetic unchanged reply');
          expect(readOpenCodeSessionPermission(native)).toEqual(reconciled);
        }
        expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(1);
        expect(messagesOfType((await fixture.client.getMessages(chatId)).messages, 'permission-request')).toHaveLength(1);
        environment.model.assertSettled();
      } finally { held.release(); }
    }, options());
  }, 120_000);

  test('reconciles a setting saved with no runtime before the first resumed prompt', async () => {
    await withIntegrationFixture('opencode-settings-restart', async fixture => {
      const chatId = await startIdle(fixture, 'default');
      const native = await openCodeNativeSession(fixture, chatId);
      const original = readOpenCodeSessionPermission(native);
      await fixture.restartGarcon();
      await savePermission(fixture, chatId, 'acceptEdits');
      expect(readOpenCodeSessionPermission(native)).toEqual(original);
      const held = environment.model.scriptHeldTurn([chatCompletionsText('synthetic restarted reply')]);
      try {
        const cursor = fixture.client.markEvents();
        const turn = await runPersisted(fixture, chatId);
        await held.requested;
        expect(readOpenCodeSessionPermission(native)?.slice(-3)).toEqual(acceptEditsRules);
        expect((await openCodeNativeSession(fixture, chatId)).agentSessionId).toBe(native.agentSessionId);
        held.release();
        await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor,
          marker: 'synthetic restarted reply' });
        environment.model.assertSettled();
      } finally { held.release(); }
    }, options());
  }, 120_000);

  test('rejects a known bypass exit and refuses unrecoverable native policy after restart', async () => {
    await withIntegrationFixture('opencode-settings-bypass-exit', async fixture => {
      const chatId = await startIdle(fixture, 'bypassPermissions');
      const native = await openCodeNativeSession(fixture, chatId);
      const original = readOpenCodeSessionPermission(native);
      await expect(savePermission(fixture, chatId, 'default')).rejects.toMatchObject({
        body: { errorCode: 'OPERATION_UNSUPPORTED', retryable: false },
      });
      expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.permissionMode)
        .toBe('bypassPermissions');
      expect(readOpenCodeSessionPermission(native)).toEqual(original);
      expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(0);
      await fixture.restartGarcon();
      await savePermission(fixture, chatId, 'default');
      const cursor = fixture.client.markEvents();
      const turn = await runPersisted(fixture, chatId);
      expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, { afterIndex: cursor })).type)
        .toBe('agent-run-failed');
      expect(environment.model.requests()).toHaveLength(1);
      expect(readOpenCodeSessionPermission(native)).toEqual(original);
      expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(0);
      environment.model.assertSettled();
    }, options());
  }, 120_000);

  test('does not prompt after a lost native permission reply and recognizes the landed update on a later turn', async () => {
    await withIntegrationFixture('opencode-settings-lost-reply', async fixture => {
      const chatId = await startIdle(fixture, 'default');
      const native = await openCodeNativeSession(fixture, chatId);
      await savePermission(fixture, chatId, 'acceptEdits');
      const transport = OpenCodeTransportController.forFixture(fixture.dirs);
      const path = `/session/${encodeURIComponent(native.agentSessionId)}`;
      await transport.holdNextResponse(path, 'PATCH');
      const cursor = fixture.client.markEvents();
      const turn = await runPersisted(fixture, chatId);
      const responseId = await transport.waitForResponseHeld(path);
      expect(readOpenCodeSessionPermission(native)?.slice(-3)).toEqual(acceptEditsRules);
      expect((await fixture.client.waitForTurnTerminal(chatId, turn.turnId, {
        afterIndex: cursor, timeoutMs: 20_000,
      })).type).toBe('agent-run-failed');
      expect(environment.model.requests()).toHaveLength(1);
      await transport.waitForResponseClosed(responseId);
      const landed = readOpenCodeSessionPermission(native);
      environment.model.scriptTurn([chatCompletionsText('synthetic recovered reply')]);
      await resume(fixture, chatId, 'synthetic recovered reply');
      expect(readOpenCodeSessionPermission(native)).toEqual(landed);
      expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(1);
      environment.model.assertSettled();
    }, options());
  }, 120_000);

  test('persists model and thinking changes without native permission writes', async () => {
    await withIntegrationFixture('opencode-settings-model', async fixture => {
      const chatId = await startIdle(fixture, 'default');
      const native = await openCodeNativeSession(fixture, chatId);
      const original = readOpenCodeSessionPermission(native);
      await fixture.client.patch('/api/v1/chats/model', { chatId, model: OPENCODE_TEST_REASONING_MODEL });
      expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
        chatId, thinkingMode: 'low',
      })).toMatchObject({ success: true, thinkingMode: 'low' });
      expect(readOpenCodeSessionPermission(native)).toEqual(original);
      expect(await permissionWrites(fixture, native.agentSessionId)).toHaveLength(0);
      expect(environment.model.requests()).toHaveLength(1);
      environment.model.assertSettled();
    }, options());
  }, 120_000);
});

const acceptEditsRules = [
  { permission: 'edit', pattern: '*', action: 'allow' },
  { permission: 'bash', pattern: '*', action: 'ask' },
  { permission: 'webfetch', pattern: '*', action: 'allow' },
];

function options(): IntegrationFixtureOptions {
  return { authentication: 'account', bindAddress: '0.0.0.0',
    resolveServerEnvironment: environment.resolveServerEnvironment, prepareWorkspace: environment.prepareWorkspace,
    afterGarconStop: environment.afterGarconStop, extraDiagnostics: environment.extraDiagnostics };
}

async function savePermission(fixture: IntegrationFixture, chatId: string, permissionMode: PermissionMode) {
  return fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', { chatId, permissionMode });
}

async function startIdle(fixture: IntegrationFixture, permissionMode: PermissionMode): Promise<string> {
  environment.model.scriptTurn([chatCompletionsText('synthetic initial reply')]);
  const chatId = fixture.newChatId();
  const cursor = fixture.client.markEvents();
  const turn = await fixture.client.startChat(scriptedOpenCodeStartRequest({
    chatId, projectPath: fixture.dirs.project, command: 'synthetic initial input', permissionMode,
  }));
  await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor, marker: 'synthetic initial reply' });
  return chatId;
}

function runPersisted(fixture: IntegrationFixture, chatId: string) {
  return fixture.client.runChat({ chatId, command: 'synthetic resumed input',
    clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
}

async function resume(fixture: IntegrationFixture, chatId: string, marker: string) {
  const cursor = fixture.client.markEvents();
  const turn = await runPersisted(fixture, chatId);
  await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor, marker });
}

async function allowNextPermission(fixture: IntegrationFixture, chatId: string, afterIndex: number) {
  const row = await fixture.client.waitForTransientPermission(chatId, () => true, { afterIndex });
  if (row.message.type !== 'permission-request') throw new Error('Expected a synthetic permission request');
  expect(await fixture.client.sendPermissionDecision({ chatId, clientRequestId: crypto.randomUUID(),
    permissionOccurrenceId: row.message.permissionOccurrenceId, allow: true, alwaysAllow: false,
  })).toMatchObject({ status: 'accepted' });
}

async function permissionWrites(fixture: IntegrationFixture, sessionId: string) {
  return (await OpenCodeTransportController.forFixture(fixture.dirs).requests())
    .filter(request => request.method === 'PATCH' && request.path === `/session/${encodeURIComponent(sessionId)}`);
}
