import { expect, test } from 'bun:test';
import type { ExecutorConnection, ExecutorSnapshot } from '../../../common/executors.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test.each(['remote-controller-dials', 'remote-executor-dials'] as const)(
  'unchanged connection updates preserve busy work while disabling is rejected (%s)', async executionBackend => {
  await withIntegrationFixture(`executor-busy-config-${executionBackend}`, async fixture => {
    const { client } = fixture;
    const route = `/api/v1/executors/${client.executorId}`;
    const connection = await client.get<ExecutorConnection>(`${route}/connection`);
    const snapshot = async () => (await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors'))
      .executors.find(executor => executor.id === client.executorId)!;
    const before = await snapshot();
    const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
    try {
      const chatId = fixture.newChatId();
      const started = await client.startDirectChat({
        chatId, content: 'Synthetic held configuration turn', projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi,
      });
      await held.received;
      const cursor = client.markEvents();
      await client.patch(route, { enabled: true, connection: { ...connection, direction: before.direction } });
      await expect(client.patch(route, { enabled: false })).rejects.toMatchObject({
        status: 409, body: { errorCode: 'EXECUTOR_IN_USE' },
      });
      expect(await snapshot()).toEqual(before);
      expect(held.releaseText('Synthetic uninterrupted configuration reply')).toBe(true);
      expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
      expect(client.eventsSince(cursor).filter(event => event.type === 'executors-changed'
        && event.executors.some(executor => executor.id === client.executorId && executor.availability !== 'ready'))).toEqual([]);
    } finally { held.releaseText('Synthetic cleanup reply'); }
  }, { executionBackend });
}, 60_000);

test('advertised URL edits preserve a busy executor and its running turn', async () => {
  await withIntegrationFixture('executor-advertised-url', async (fixture) => {
    const { client } = fixture;
    const id = client.executorId;
    const route = `/api/v1/executors/${id}`;
    const before = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
    const connection = await client.get<ExecutorConnection>(`${route}/connection`);
    const advertised = new URL(connection.connectionUrl);
    advertised.hostname = 'advertised.example';
    advertised.pathname = '/any-prefix';
    advertised.search = '?route=worker';
    const held = fixture.fakeProviders.openAi.holdNext({ model: fixture.directAgents.openAi.provider.model });
    const chatId = fixture.newChatId();
    const started = await client.startDirectChat({
      chatId, content: 'Synthetic held turn', projectPath: fixture.executionDirs.project, agent: fixture.directAgents.openAi,
    });
    await held.received;
    const afterIndex = client.markEvents();
    await client.patch(route, { enabled: true, connection: {
      direction: 'executor-connects', connectionUrl: advertised.href,
      allowInsecureDevelopment: connection.allowInsecureDevelopment,
    } });
    const after = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
    expect(after.executors.find((executor) => executor.id === id)).toEqual(before.executors.find((executor) => executor.id === id));
    expect((await client.get<ExecutorConnection>(`${route}/connection`)).connectionUrl).toBe(advertised.href);
    expect(held.releaseText('Synthetic uninterrupted turn')).toBe(true);
    expect(await client.waitForTurnTerminal(chatId, started.turnId)).toMatchObject({ type: 'agent-run-finished' });
    expect(client.eventRecords().slice(afterIndex).filter(({ parsed }) => parsed.type === 'executors-changed'
      && parsed.executors.some((executor) => executor.id === id && executor.availability !== 'ready'))).toEqual([]);
  }, { executionBackend: 'remote-executor-dials' });
}, 60_000);
