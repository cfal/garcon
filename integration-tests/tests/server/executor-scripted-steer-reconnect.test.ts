import { expect, test } from 'bun:test';
import type {
  AgentRunFailedMessage,
  AgentRunFinishedMessage,
  ExecutorsChangedMessage,
} from '../../../common/ws-events.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { userContents } from '../../support/chat-assertions.js';
import { ClaudeSessionStartGate } from '../../support/claude-session-start-gate.js';
import { withTimeout } from '../../support/deferred.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { expectFinished } from '../../support/live-agent.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`a steer queued before the turn can take it reaches that turn across a link outage (${executionBackend})`, async () => {
    const environment = await startScriptedClaudeTestEnvironment();
    const gate = new ClaudeSessionStartGate();
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    const prompt = marker('PROMPT');
    const steer = marker('STEER');
    const held = environment.model.scriptHeldTurn([claudeText(marker('FIRST_REPLY'))]);
    environment.model.scriptTurn([claudeText(marker('STEER_REPLY'))]);
    try {
      await withIntegrationFixture(`scripted-steer-reconnect-${executionBackend}`, async (fixture) => {
        const { client } = fixture;
        const chatId = fixture.newChatId();
        const cursor = client.markEvents();
        const started = await client.startChat(liveClaudeStartRequest({
          chatId,
          projectPath: fixture.dirs.project,
          command: prompt,
          permissionMode: 'bypassPermissions',
        }));
        if (!started.turnId) throw new Error('Scripted Claude start did not return a turn identity.');
        expect(await client.steer({
          clientRequestId: crypto.randomUUID(),
          clientMessageId: crypto.randomUUID(),
          chatId,
          content: steer,
          whenTurnUnavailable: 'queue',
        })).toMatchObject({ delivery: 'queued' });

        // The turn becomes steerable while the link is down, so only the worker sees it happen.
        const outage = client.markEvents();
        proxy!.refuseConnections();
        proxy!.disconnect();
        await client.waitForEvent(
          (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
            && event.executors.some((executor) => executor.id === client.executorId
              && executor.availability === 'reconnecting'),
          'executor reconnecting',
          { afterIndex: outage, timeoutMs: 20_000 },
        );
        await gate.open();
        await withTimeout(held.requested, 30_000, () => 'Claude did not start the turn during the outage');
        expect((await client.getExecutionControl(chatId)).queue.entries
          .map((entry) => [entry.content, entry.kind])).toEqual([[steer, 'steer']]);

        proxy!.acceptConnections();
        await waitForExecutorReconnect(fixture, outage);
        await client.waitForCommittedUserInput(chatId, steer, { afterIndex: outage, timeoutMs: 20_000 });
        held.release();
        expectFinished((await client.waitForTurnTerminal(chatId, started.turnId, {
          afterIndex: cursor,
          timeoutMs: 30_000,
        })).type);

        expect(userContents((await client.getMessages(chatId)).messages)).toEqual([prompt, steer]);
        expect((await client.getExecutionControl(chatId)).queue.entries).toEqual([]);
        const [, steerRequest] = environment.model.requestsSince(0);
        expect(steerRequest?.lastUserText).toContain(steer);
        expect(client.eventsSince(cursor)
          .filter((event): event is AgentRunFinishedMessage | AgentRunFailedMessage => (
            (event.type === 'agent-run-finished' || event.type === 'agent-run-failed')
            && event.chatId === chatId
          ))
          .map((event) => event.turnId)).toEqual([started.turnId]);
        environment.model.assertSettled();
      }, {
        executionBackend,
        serverEnvironment: environment.serverEnvironment,
        prepareWorkspace: (directories) => gate.install(directories),
        interceptExecutorConnection: async (url) => {
          proxy = await tcpLinkProxy(url);
          return proxy.url;
        },
      });
    } finally {
      held.release();
      await proxy?.close();
      environment.dispose();
    }
  }, 120_000);
}

function marker(label: string): string {
  return `EXECUTOR_STEER_RECONNECT_${label}_${crypto.randomUUID()}`;
}
