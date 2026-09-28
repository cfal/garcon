import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ChatProcessingUpdatedMessage } from '../../../common/ws-events.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { messagesOfType } from '../../support/chat-assertions.js';
import { withTimeout } from '../../support/deferred.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { claudeText, claudeToolUse } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`a link blip keeps a pending real Claude permission answerable and delivers the answer once (${executionBackend})`, async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    const marker = '.synthetic-approved-after-reconnect';
    const toolUseId = 'toolu_synthetic_reconnect';
    environment.model.scriptTurn([claudeToolUse(toolUseId, 'Bash', { command: `touch ${marker}` })]);
    const approved = environment.model.scriptHeldTurn([claudeText('Synthetic reply after approved permission')]);
    try {
      await withIntegrationFixture(`scripted-permission-reconnect-${executionBackend}`, async fixture => {
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
        const terminals = () => fixture.client.events().filter(event =>
          (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
          && event.chatId === chatId && event.turnId === started.turnId);
        const cursor = fixture.client.markEvents();
        const processingPhase = (phase: ChatProcessingUpdatedMessage['phase']) => fixture.client.waitForEvent(
          (event): event is ChatProcessingUpdatedMessage => event.type === 'chat-processing-updated'
            && event.chatId === chatId && event.phase === phase,
          `${chatId} processing ${phase}`, { afterIndex: cursor, timeoutMs: 20_000 },
        );
        proxy!.disconnect();
        const reconnecting = await processingPhase('reconnecting');
        await waitForExecutorReconnect(fixture, cursor);
        const resumed = await processingPhase('running');

        // The turn and its pending permission survive the blip; nothing was denied.
        expect(fixture.client.events().indexOf(reconnecting)).toBeLessThan(fixture.client.events().indexOf(resumed));
        expect(fixture.client.eventsSince(cursor).some(event => event.type === 'executors-changed'
          && event.executors.some(executor => executor.availability === 'reconnecting'))).toBe(true);
        expect(terminals()).toEqual([]);
        expect((await fixture.client.getChatSnapshot(chatId, 0)).transientFeed.rows.map(row => row.message.type))
          .toEqual(['permission-request']);
        await fixture.client.sendPermissionDecision({
          clientRequestId: crypto.randomUUID(), chatId, permissionOccurrenceId: permission.permissionOccurrenceId,
          allow: true, alwaysAllow: false, control,
        });
        const approval = await withTimeout(approved.requested, 30_000, () => 'Claude did not receive the approved tool result');
        expect(approval.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({
          role: 'user', content: expect.arrayContaining([expect.objectContaining({
            type: 'tool_result', tool_use_id: toolUseId,
          })]),
        })]));
        approved.release();
        expect(await fixture.client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });

        expect(await Bun.file(join(fixture.dirs.project, marker)).exists()).toBe(true);
        const messages = (await fixture.client.getMessages(chatId)).messages;
        expect(messagesOfType(messages, 'permission-resolved')).toHaveLength(1);
        expect(JSON.stringify(messages)).toContain('Synthetic reply after approved permission');
        expect(environment.model.requestsSince(0)).toHaveLength(2);
        expect(proxy!.connections).toBe(2);
        expect(terminals()).toHaveLength(1);
        environment.model.assertSettled();
      }, {
        executionBackend,
        serverEnvironment: environment.serverEnvironment,
        interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { approved.release(); await proxy?.close(); environment.dispose(); }
  }, 60_000);
}
