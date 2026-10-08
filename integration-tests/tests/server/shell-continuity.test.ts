import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorsChangedMessage } from '../../../common/ws-events.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';

for (const executionBackend of ['remote-controller-dials', 'remote-executor-dials'] as const) {
  test(`Shell output and side effects survive reconnect without replay (${executionBackend})`, async () => {
    let proxy: Awaited<ReturnType<typeof tcpLinkProxy>> | undefined;
    try {
      await withIntegrationFixture(`shell-continuity-${executionBackend}`, async fixture => {
        const { client, executionDirs } = fixture;
        const chatId = fixture.newChatId();
        const started = await client.startChat({
          chatId, agentId: 'shell', model: 'sh', projectPath: executionDirs.project,
          permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
          origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          command: 'printf once >> executions; printf ready; while [ ! -f release ]; do sleep 0.05; done; printf retained; printf diagnostic >&2',
        });
        for (let retry = 0; retry < 1000 && !await Bun.file(join(executionDirs.project, 'executions')).exists(); retry++) {
          await Bun.sleep(10);
        }
        expect(await readFile(join(executionDirs.project, 'executions'), 'utf8')).toBe('once');
        const cursor = client.markEvents();
        proxy!.refuseConnections();
        proxy!.disconnect();
        await client.waitForEvent(
          (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
            && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'reconnecting'),
          'executor reconnecting', { afterIndex: cursor, timeoutMs: 20_000 },
        );
        await writeFile(join(executionDirs.project, 'release'), '');
        proxy!.acceptConnections();
        await waitForExecutorReconnect(fixture, cursor);
        expect((await client.waitForTurnTerminal(chatId, started.turnId, { afterIndex: cursor })).type).toBe('agent-run-finished');
        await client.waitForProcessing(chatId, false);
        expect(await readFile(join(executionDirs.project, 'executions'), 'utf8')).toBe('once');
        const before = (await client.getMessages(chatId)).messages.map(row => row.message)
          .filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
        expect(before.flatMap(message => message.type === 'command-output' && message.channel === 'stdout'
          ? [message.content] : []).join('')).toBe('readyretained');
        await fixture.crashAndRestartExecutorWorker();
        await client.reloadChat(chatId);
        const after = (await client.getMessages(chatId)).messages.map(row => row.message)
          .filter(message => ['user-message', 'command-output', 'command-result'].includes(message.type));
        expect(after).toEqual(before);
        expect(await readFile(join(executionDirs.project, 'executions'), 'utf8')).toBe('once');
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
        expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);
      }, {
        executionBackend,
        interceptExecutorConnection: async url => { proxy = await tcpLinkProxy(url); return proxy.url; },
      });
    } finally { await proxy?.close(); }
  }, 90_000);
}

test('handoff into literal execution retains history without AI preparation or replay', async () => {
  await withIntegrationFixture('shell-handoff', async fixture => {
    const { client } = fixture;
    const chatId = fixture.newChatId();
    const first = await client.startDirectChat({ chatId, agent: fixture.directAgents.openAi,
      projectPath: fixture.executionDirs.project, content: 'Synthetic historical request' });
    await client.waitForTurnTerminal(chatId, first.turnId);
    await client.waitForProcessing(chatId, false);
    const requests = fixture.fakeProviders.openAi.requests().length;
    const chat = (await client.listChats()).sessions.find(chat => chat.id === chatId)!;
    const switched = await client.runChat({ chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      command: 'printf current-command', handoff: { expectedAgentOwnershipEpoch: chat.agentOwnershipEpoch,
        target: { agentId: 'shell', model: 'sh', permissionMode: 'default', thinkingMode: 'none',
          agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} } },
      },
    });
    expect((await client.waitForTurnTerminal(chatId, switched.turnId)).type).toBe('agent-run-finished');
    await client.waitForProcessing(chatId, false);
    await client.reloadChat(chatId);
    const messages = (await client.getMessages(chatId)).messages.map(row => row.message);
    expect(messages.some(message => message.type === 'user-message' && message.content === 'Synthetic historical request')).toBe(true);
    expect(messages.flatMap(message => message.type === 'command-output' && message.channel === 'stdout'
      ? [message.content] : []).join('')).toBe('current-command');
    expect(fixture.fakeProviders.openAi.requests()).toHaveLength(requests);
    expect(fixture.fakeProviders.anthropic.requests()).toHaveLength(0);
  });
}, 60_000);
