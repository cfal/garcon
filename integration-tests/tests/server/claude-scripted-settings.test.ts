import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ExecutionSettingsPatchResponse, ModelPatchRequest } from '../../../common/chat-command-contracts.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { waitForPersistedNativeSession } from '../../support/persisted-chat.js';
import { startScriptedClaudeTestEnvironment, type ScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

describe('scripted Claude session settings', () => {
  let environment: ScriptedClaudeTestEnvironment;
  beforeEach(async () => { environment = await startScriptedClaudeTestEnvironment(); });
  afterEach(() => { environment.dispose(); });

  for (const active of [true, false]) {
    test(`a refused deferred model save preserves the native configuration while active=${active}`, async () => {
      const held = environment.model.scriptHeldTurn([claudeText('synthetic retained model reply')]);
      try {
        await withIntegrationFixture(`claude-settings-deferred-${active}`, async fixture => {
          const chatId = fixture.newChatId();
          const cursor = fixture.client.markEvents();
          const first = await fixture.client.startChat({
            ...liveClaudeStartRequest({ chatId, projectPath: fixture.dirs.project, command: 'synthetic initial input' }),
            model: 'haiku',
          });
          const initialRequest = await held.requested;
          if (!active) {
            held.release();
            await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, afterIndex: cursor,
              marker: 'synthetic retained model reply' });
          }
          await expect(fixture.client.patch('/api/v1/chats/model', { chatId, model: 'sonnet' } satisfies ModelPatchRequest))
            .rejects.toMatchObject({ status: 409, body: { errorCode: 'SOURCE_REVISION_CHANGED' } });
          expect((await fixture.client.listChats()).sessions.find(chat => chat.id === chatId)?.model).toBe('haiku');
          if (active) {
            held.release();
            await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, afterIndex: cursor,
              marker: 'synthetic retained model reply' });
          }
          const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'claude' });
          environment.model.scriptTurn([claudeText('synthetic resumed model reply')]);
          const resumedCursor = fixture.client.markEvents();
          const resumed = await fixture.client.runChat({ chatId, command: 'synthetic resumed input',
            clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
          await waitForVisibleResponse({ fixture, chatId, turnId: resumed.turnId, afterIndex: resumedCursor,
            marker: 'synthetic resumed model reply' });
          expect(environment.model.requests()).toHaveLength(2);
          expect(environment.model.requests().at(-1)!.body.model).toBe(initialRequest.body.model);
          expect((await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'claude' })).agentSessionId)
            .toBe(native.agentSessionId);
          environment.model.assertSettled();
        }, {
          authentication: 'account', bindAddress: '0.0.0.0',
          preloadModules: [fileURLToPath(new URL('../../support/claude-settings-save-failure-preload.ts', import.meta.url))],
          serverEnvironment: { ...environment.serverEnvironment, GARCON_TEST_REFUSED_SETTINGS_MODEL: 'sonnet' },
        });
      } finally { held.release(); }
    }, 120_000);
  }

  for (const [previous, next] of [['default', 'manualBypass'], ['manualBypass', 'default']] as const) {
    test(`confirms active permission control from ${previous} to ${next}`, async () => {
      const held = environment.model.scriptHeldTurn([claudeToolUse('toolu_settings', 'Bash', {
        command: 'printf synthetic-settings-output > settings-output.txt',
      })]);
      environment.model.scriptTurn([claudeText('synthetic settings reply')]);
      try {
        await withIntegrationFixture(`claude-settings-live-${next}`, async fixture => {
          const chatId = fixture.newChatId();
          const cursor = fixture.client.markEvents();
          const turn = await fixture.client.startChat(liveClaudeStartRequest({
            chatId, projectPath: fixture.dirs.project, command: 'synthetic settings input', permissionMode: previous,
          }));
          await held.requested;
          expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
            chatId, permissionMode: next,
          })).toMatchObject({ success: true, permissionMode: next });
          held.release();
          if (next === 'default') {
            const row = await fixture.client.waitForTransientPermission(chatId, () => true, { afterIndex: cursor });
            if (row.message.type !== 'permission-request') throw new Error('Expected synthetic permission');
            expect(await fixture.client.sendPermissionDecision({ chatId, clientRequestId: crypto.randomUUID(),
              permissionOccurrenceId: row.message.permissionOccurrenceId, allow: true, alwaysAllow: false,
            })).toMatchObject({ status: 'accepted' });
          }
          await waitForVisibleResponse({ fixture, chatId, turnId: turn.turnId, afterIndex: cursor,
            marker: 'synthetic settings reply' });
          expect(await readFile(join(fixture.dirs.project, 'settings-output.txt'), 'utf8')).toBe('synthetic-settings-output');
          expect(messagesOfType((await fixture.client.getMessages(chatId)).messages, 'permission-request'))
            .toHaveLength(next === 'default' ? 1 : 0);
          environment.model.assertSettled();
        }, { authentication: 'account', bindAddress: '0.0.0.0', serverEnvironment: environment.serverEnvironment });
      } finally { held.release(); }
    }, 120_000);
  }

  for (const restart of [false, true]) {
    test(`resumes the same native session with saved idle configuration after restart=${restart}`, async () => {
      environment.model.scriptTurn([claudeText('synthetic initial reply')]);
      await withIntegrationFixture(`claude-settings-idle-${restart}`, async fixture => {
        const chatId = fixture.newChatId();
        const cursor = fixture.client.markEvents();
        const first = await fixture.client.startChat(liveClaudeStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'synthetic initial input', permissionMode: 'default',
        }));
        await waitForVisibleResponse({ fixture, chatId, turnId: first.turnId, afterIndex: cursor,
          marker: 'synthetic initial reply' });
        const native = await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'claude' });
        if (restart) await fixture.restartGarcon();
        expect(await fixture.client.patch<ExecutionSettingsPatchResponse>('/api/v1/chats/execution-settings', {
          chatId, permissionMode: 'bypassPermissions', thinkingMode: 'none', agentSettingsPatch: { claudeThinkingMode: 'off' },
        })).toMatchObject({ success: true, permissionMode: 'bypassPermissions', thinkingMode: 'none' });
        environment.model.scriptTurn([claudeToolUse('toolu_settings_resumed', 'Bash', {
          command: 'printf synthetic-resumed-output > settings-resumed.txt',
        })]);
        environment.model.scriptTurn([claudeText('synthetic resumed reply')]);
        const resumedCursor = fixture.client.markEvents();
        const resumed = await fixture.client.runChat({ chatId, command: 'synthetic resumed input',
          clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID() });
        await waitForVisibleResponse({ fixture, chatId, turnId: resumed.turnId, afterIndex: resumedCursor,
          marker: 'synthetic resumed reply' });
        expect(await readFile(join(fixture.dirs.project, 'settings-resumed.txt'), 'utf8')).toBe('synthetic-resumed-output');
        expect(messagesOfType((await fixture.client.getMessages(chatId)).messages, 'permission-request')).toHaveLength(0);
        expect((await waitForPersistedNativeSession({ directories: fixture.dirs, chatId, agentId: 'claude' })).agentSessionId)
          .toBe(native.agentSessionId);
        environment.model.assertSettled();
      }, { authentication: 'account', bindAddress: '0.0.0.0', serverEnvironment: environment.serverEnvironment });
    }, 120_000);
  }
});
