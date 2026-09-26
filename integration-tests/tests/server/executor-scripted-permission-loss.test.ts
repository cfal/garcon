import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { reloadUntilNativeContains } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`link loss denies a pending real Claude permission without executing or replaying it (${executionBackend})`, async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    const command = 'touch .synthetic-must-not-exist';
    environment.model.scriptTurn([claudeToolUse('toolu_synthetic_detached', 'Bash', { command })]);
    const denied = environment.model.scriptHeldTurn(request => {
      expect(JSON.stringify(request.body.messages)).toContain('"is_error":true');
      return [claudeText('Synthetic reply after denied permission')];
    });
    try {
      await withIntegrationFixture(`scripted-permission-loss-${executionBackend}`, async fixture => {
        const chatId = fixture.newChatId();
        const started = await fixture.client.startChat(liveClaudeStartRequest({
          chatId, projectPath: fixture.dirs.project, command: 'Synthetic permission prompt',
        }));
        const permission = await fixture.client.waitForTransientPermission(chatId, () => true);
        const snapshot = await fixture.client.getChatSnapshot(chatId, 0);
        const control = {
          serverInstanceId: snapshot.transientFeed.serverInstanceId, chatId, runId: permission.runId,
          permissionOccurrenceId: permission.permissionOccurrenceId,
        };
        const cursor = fixture.client.markEvents();
        proxy!.disconnect();
        expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({
          type: 'agent-run-failed', error: expect.stringContaining('Reload from native history'),
        });
        await denied.requested;
        await waitForExecutorReconnect(fixture, cursor);
        expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows).toEqual([]);
        await expect(fixture.client.sendPermissionDecision({
          clientRequestId: crypto.randomUUID(), chatId, permissionOccurrenceId: permission.permissionOccurrenceId,
          allow: true, alwaysAllow: false, control,
        })).rejects.toMatchObject({ status: 409, body: { errorCode: 'PERMISSION_NOT_ACTIONABLE' } });
        expect(messagesOfType((await fixture.client.getMessages(chatId)).messages, 'permission-resolved')).toEqual([]);
        denied.release();
        await reloadUntilNativeContains(fixture, chatId, 'Synthetic reply after denied permission');
        expect(await Bun.file(join(fixture.dirs.project, '.synthetic-must-not-exist')).exists()).toBe(false);
        expect(environment.model.requestsSince(0)).toHaveLength(2);
        expect(proxy!.connections).toBe(2);
        expect(fixture.client.eventRecords().filter(({ parsed }) => parsed.type === 'agent-run-failed'
          && parsed.chatId === chatId && parsed.turnId === started.turnId)).toHaveLength(1);
        environment.model.assertSettled();
      }, {
        executionBackend,
        serverEnvironment: environment.serverEnvironment,
        interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { denied.release(); await proxy?.close(); environment.dispose(); }
  }, 60_000);
}
