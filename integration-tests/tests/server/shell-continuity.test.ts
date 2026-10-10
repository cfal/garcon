import { expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorsChangedMessage } from '../../../common/ws-events.js';
import type { AgentHandoffRequest } from '../../../common/chat-command-contracts.js';
import { tcpLinkProxy } from '../../../server/remote/__tests__/tcp-link-proxy.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { waitForExecutorReconnect } from '../../support/executor-link.js';
import { rejectionOf } from '../../support/promise-assertions.js';

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
        expect((await client.getMessages(chatId)).messages.some(row => row.message.type === 'command-output')).toBe(false);
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

test('both handoff routes reject literal destinations without changing ownership or history', async () => {
  await withIntegrationFixture('shell-handoff-rejection', async fixture => {
    const { client } = fixture;
    const chatId = fixture.newChatId();
    const first = await client.startDirectChat({ chatId, agent: fixture.directAgents.openAi,
      projectPath: fixture.executionDirs.project, content: 'Synthetic historical request' });
    await client.waitForTurnTerminal(chatId, first.turnId);
    await client.waitForProcessing(chatId, false);
    const before = (await client.getMessages(chatId)).messages;
    const chat = (await client.listChats()).sessions.find(chat => chat.id === chatId)!;
    const handoff = { expectedAgentOwnershipEpoch: chat.agentOwnershipEpoch,
      target: { agentId: 'shell', model: 'sh', permissionMode: 'default', thinkingMode: 'none',
        agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} } },
    } satisfies AgentHandoffRequest;
    expect(await rejectionOf(client.post('/api/v1/chats/agent-handoff', {
      chatId, clientRequestId: crypto.randomUUID(), handoff,
    }))).toMatchObject({ status: 422 });
    expect(await rejectionOf(client.runChat({
      chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
      command: 'touch rejected-command', handoff,
    }))).toMatchObject({ status: 422 });
    expect((await client.listChats()).sessions.find(chat => chat.id === chatId)).toMatchObject({
      agentId: chat.agentId, agentOwnershipEpoch: chat.agentOwnershipEpoch,
    });
    expect((await client.getMessages(chatId)).messages).toEqual(before);
    expect(await Bun.file(join(fixture.executionDirs.project, 'rejected-command')).exists()).toBe(false);
  });
}, 60_000);

for (const promptless of [false, true]) {
  test(`Shell hands retained command evidence to AI (${promptless ? 'selection-only' : 'with prompt'})`, async () => {
    await withIntegrationFixture(`shell-outgoing-handoff-${promptless}`, async fixture => {
      const { client } = fixture;
      const chatId = fixture.newChatId();
      const command = 'mkdir next; printf once >> executions; printf synthetic-stdout; printf synthetic-stderr >&2; cd next';
      const started = await client.startChat({
        chatId, agentId: 'shell', model: 'sh', projectPath: fixture.executionDirs.project,
        permissionMode: 'default', thinkingMode: 'none', agentSettings: { ownerId: 'shell', schemaVersion: 1, values: {} },
        origin: 'interactive', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), command,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      await client.waitForProcessing(chatId, false);
      const agent = fixture.directAgents.openAi;
      if (promptless) {
        const chat = (await client.listChats()).sessions.find(chat => chat.id === chatId)!;
        await client.post('/api/v1/chats/agent-handoff', {
          chatId, clientRequestId: crypto.randomUUID(),
          handoff: { expectedAgentOwnershipEpoch: chat.agentOwnershipEpoch,
            target: { agentId: agent.agentId, model: agent.provider.model,
              apiProviderId: agent.provider.providerId, modelEndpointId: agent.provider.endpointId,
              permissionMode: 'default', thinkingMode: 'none', agentSettings: agent.agentSettings },
          },
        });
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(0);
      }
      const received = fixture.fakeProviders.openAi.holdNext({ model: agent.provider.model });
      const input = { chatId, agent, content: 'Summarize the synthetic command.' };
      const next = await (promptless ? client.runDirectChat(input) : client.handoffDirectChat(input));
      const request = await received.received;
      expect(request.lastUserText).toContain('<execution-output>');
      expect(request.lastUserText).toContain('synthetic-stdout');
      expect(request.lastUserText).toContain('synthetic-stderr');
      expect(request.lastUserText).toContain('Starting directory: ' + fixture.executionDirs.project);
      expect(request.lastUserText).toContain('Working directory: ' + join(fixture.executionDirs.project, 'next'));
      expect(request.lastUserText).toContain('Completed');
      received.releaseText('Synthetic summary.');
      expect((await client.waitForTurnTerminal(chatId, next.turnId)).type).toBe('agent-run-finished');
      await client.waitForProcessing(chatId, false);
      expect(await readFile(join(fixture.executionDirs.project, 'executions'), 'utf8')).toBe('once');
      const messages = (await client.getMessages(chatId)).messages.map(row => row.message);
      expect(messages).toContainEqual(expect.objectContaining({ type: 'user-message', content: command }));
      expect(messages.some(message => message.type === 'command-result')).toBe(true);
    });
  }, 60_000);
}
