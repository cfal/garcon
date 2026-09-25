import { expect, test } from 'bun:test';
import type { RemoteSettingsSnapshot } from '../../../common/settings.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('executor pin mutations preserve concurrent startup recents and unrelated executor preferences', async () => {
  await withIntegrationFixture('executor-path-preferences', async (fixture) => {
    const { client, directAgents, dirs } = fixture;
    const otherExecutor = '33333333-3333-4333-8333-333333333333';
    const patch = (executorId: string, pinnedPaths: string[]) => ({ paths: { byExecutor: { [executorId]: { pinnedPaths } } } });
    const initial = await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings');
    expect(initial.paths.byExecutor?.[client.executorId]).toBeUndefined();
    const chatId = fixture.newChatId();
    const [started] = await Promise.all([
      client.startDirectChat({ chatId, content: 'Synthetic preference update', projectPath: dirs.project, agent: directAgents.openAi }),
      client.put('/api/v1/app/settings', patch(otherExecutor, ['/other/pin'])),
      client.put('/api/v1/app/settings', patch(client.executorId, ['/remote/pin'])),
    ]);
    await client.waitForTurnTerminal(chatId, started.turnId);
    const expected = {
      [client.executorId]: { recentPaths: [dirs.project], pinnedPaths: ['/remote/pin'] },
      [otherExecutor]: { recentPaths: [], pinnedPaths: ['/other/pin'] },
    };
    expect((await client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).paths.byExecutor).toEqual(expected);
    await expect(client.put('/api/v1/app/settings', { paths: { byExecutor: { [client.executorId]: { recentPaths: [] } } } })).rejects.toThrow();
    await fixture.restartGarcon();
    expect((await fixture.client.get<RemoteSettingsSnapshot>('/api/v1/app/settings')).paths.byExecutor).toEqual(expected);
  }, { executionBackend: 'remote-controller-dials' });
}, 60_000);
