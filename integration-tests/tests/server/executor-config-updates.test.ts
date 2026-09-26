import { expect, test } from 'bun:test';
import type { ExecutorConnection, ExecutorSnapshot } from '../../../common/executors.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('advertised URL edits preserve a busy executor and its running turn', async () => {
  await withIntegrationFixture('executor-advertised-url', async (fixture) => {
    const { client } = fixture;
    const id = client.executorId;
    const route = `/api/v1/executors/${id}`;
    const before = await client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors');
    const connection = await client.get<ExecutorConnection>(`${route}/connection`);
    const advertised = new URL(connection.connectionUrl);
    advertised.hostname = 'advertised.example';
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
